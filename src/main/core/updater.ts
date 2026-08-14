/**
 * 检查更新：多级回退获取最新 Release（GitHub API 匿名限流 403 时自动降级）
 *
 * 通道优先级：
 *   1. GitHub REST API（releases/latest）—— 含完整更新说明，但匿名限流 60 次/小时
 *   2. releases.atom（网页资源，不占 API 配额）—— 含版本 + 说明（HTML）
 *   3. releases/latest 网页 302 重定向 —— 只有版本号（从最终 URL 解析）
 *
 * 失败结果缓存 2 分钟（避免用户狂点加剧限流）；成功缓存 5 分钟。
 */
import { app } from 'electron'
import type { UpdateCheckResult } from '@shared/types'

const REPO = 'HHHEEEWWW/bepinex-manager'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const ATOM_URL = `https://github.com/${REPO}/releases.atom`
const LATEST_URL = `https://github.com/${REPO}/releases/latest`
const UA = 'bepinex-manager'

/** 成功缓存时长（毫秒） */
const CACHE_TTL_OK = 5 * 60 * 1000
/** 失败缓存时长（毫秒），防连点加剧限流 */
const CACHE_TTL_ERR = 2 * 60 * 1000

let cached: { at: number; result: UpdateCheckResult } | null = null

/** 版本号比较：'0.1.1' vs '0.1.0' → 1；忽略 v 前缀与预发布段 */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.+-]/).map((s) => parseInt(s, 10) || 0)
  const pb = b.replace(/^v/i, '').split(/[.+-]/).map((s) => parseInt(s, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** 带超时的 fetch（返回 Response | null） */
async function fetchWithTimeout(url: string): Promise<Response | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json, application/atom+xml, text/html' },
      redirect: 'follow',
      signal: controller.signal
    })
    clearTimeout(timer)
    return res
  } catch {
    return null
  }
}

/** HTML 实体解码（atom 说明常见） */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** 通道 1：GitHub API */
async function fromApi(): Promise<{ latest: string; url: string; notes: string | null } | null> {
  const res = await fetchWithTimeout(API_URL)
  if (!res || !res.ok) return null
  const data = (await res.json()) as { tag_name?: string; html_url?: string; body?: string | null }
  const latest = String(data.tag_name ?? '').replace(/^v/i, '')
  if (!latest) return null
  return { latest, url: data.html_url ?? '', notes: data.body || null }
}

/** 通道 2：releases.atom（网页源，不受 API 限流） */
async function fromAtom(): Promise<{ latest: string; url: string; notes: string | null } | null> {
  const res = await fetchWithTimeout(ATOM_URL)
  if (!res || !res.ok) return null
  const xml = await res.text()
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)
  if (!entry) return null
  const block = entry[1]
  const link = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/)
  const content = block.match(/<content[^>]*>([\s\S]*?)<\/content>/)
  // 版本号从 link 的 /releases/tag/<tag> 提取（title 是 release 名称，不可靠）
  const tagMatch = link ? link[1].match(/\/releases\/tag\/([^/?#]+)/) : null
  const latest = tagMatch ? decodeURIComponent(tagMatch[1]).replace(/^v/i, '') : ''
  if (!latest) return null
  const notes = content ? decodeEntities(content[1].replace(/<[^>]+>/g, '').trim()) : null
  return { latest, url: link ? link[1] : `https://github.com/${REPO}/releases`, notes: notes || null }
}

/** 通道 3：releases/latest 302 重定向（从最终 URL 提取 tag） */
async function fromRedirect(): Promise<{ latest: string; url: string; notes: string | null } | null> {
  const res = await fetchWithTimeout(LATEST_URL)
  if (!res || !res.ok) return null
  const m = res.url.match(/\/releases\/tag\/([^/?#]+)/)
  if (!m) return null
  const latest = decodeURIComponent(m[1]).replace(/^v/i, '')
  if (!latest) return null
  return { latest, url: res.url, notes: null }
}

/** 依次尝试三个通道，全部失败返回 null */
async function fetchLatestRelease(): Promise<{ latest: string; url: string; notes: string | null } | null> {
  for (const fn of [fromApi, fromAtom, fromRedirect]) {
    try {
      const r = await fn()
      if (r) return r
    } catch {
      /* 尝试下一通道 */
    }
  }
  return null
}

/** 检查更新（多级回退 + 缓存） */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = app.getVersion()

  if (cached) {
    const ttl = cached.result.error ? CACHE_TTL_ERR : CACHE_TTL_OK
    if (Date.now() - cached.at < ttl) return { ...cached.result, current }
  }

  const hit = await fetchLatestRelease()
  if (!hit) {
    const result: UpdateCheckResult = {
      current,
      latest: null,
      hasUpdate: false,
      url: null,
      notes: null,
      error: 'GitHub 暂时不可用（API 限流或网络问题），请稍后再试'
    }
    cached = { at: Date.now(), result }
    return result
  }

  const hasUpdate = compareVersions(hit.latest, current) > 0
  const result: UpdateCheckResult = {
    current,
    latest: hit.latest,
    hasUpdate,
    url: hit.url,
    notes: hit.notes,
    error: null
  }
  cached = { at: Date.now(), result }
  return result
}
