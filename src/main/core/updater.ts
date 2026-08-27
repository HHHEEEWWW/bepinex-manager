/**
 * 检查更新：多级回退获取最新 Release（GitHub API 匿名限流 403 时自动降级）
 *
 * 通道优先级：
 *   1. GitHub REST API（releases/latest）—— 含完整更新说明，但匿名限流 60 次/小时
 *   2. releases.atom（网页资源，不占 API 配额）—— 含版本 + 说明（HTML）
 *   3. releases/latest 网页 302 重定向 —— 只有版本号（从最终 URL 解析）
 *
 * 失败结果缓存 2 分钟（避免用户狂点加剧限流）；成功缓存 5 分钟。
 *
 * 自动升级（安装版）：解析最新 setup.exe 资产 URL → 下载到数据根 cache/
 * → NSIS 静默安装（/S /D=<当前安装目录>）→ 自动重启。
 * 便携版不支持应用内升级（运行中 exe 被锁），降级为打开 GitHub 下载页。
 */
import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { spawn } from 'child_process'
import { dataRootDir } from './profiles'
import type {
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
  UpdateApplyResult
} from '@shared/types'

const REPO = 'HHHEEEWWW/bepinex-manager'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const ATOM_URL = `https://github.com/${REPO}/releases.atom`
const LATEST_URL = `https://github.com/${REPO}/releases/latest`
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`
const ASSETS_URL = (tag: string): string =>
  `https://github.com/${REPO}/releases/expanded_assets/${encodeURIComponent(tag)}`
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
  const autoUpdatable = isInstalledBuild()

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
      error: 'GitHub 暂时不可用（API 限流或网络问题），请稍后再试',
      autoUpdatable,
      setupUrl: null
    }
    cached = { at: Date.now(), result }
    return result
  }

  const hasUpdate = compareVersions(hit.latest, current) > 0
  const setupUrl = hasUpdate ? await resolveSetupAssetUrl(hit.latest) : null
  const result: UpdateCheckResult = {
    current,
    latest: hit.latest,
    hasUpdate,
    url: hit.url,
    notes: hit.notes,
    error: null,
    autoUpdatable,
    setupUrl
  }
  cached = { at: Date.now(), result }
  return result
}

/** 是否安装版（NSIS）：安装目录存在卸载器；便携版无卸载器 */
export function isInstalledBuild(): boolean {
  try {
    const exeDir = dirname(app.getPath('exe'))
    return existsSync(join(exeDir, 'Uninstall BepInExManager.exe'))
  } catch {
    return false
  }
}

/** 解析最新版 setup.exe 资产 URL（优先 API 资产列表，失败回退 expanded_assets 网页） */
async function resolveSetupAssetUrl(version: string): Promise<string | null> {
  const tag = `v${version}`
  // 1) GitHub API 资产列表
  const api = await fetchWithTimeout(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`)
  if (api && api.ok) {
    try {
      const data = (await api.json()) as {
        assets?: Array<{ name: string; browser_download_url: string }>
      }
      const asset = data.assets?.find((a) => a.name.endsWith('-setup.exe'))
      if (asset?.browser_download_url) return asset.browser_download_url
    } catch {
      /* 继续回退 */
    }
  }
  // 2) expanded_assets 网页（不受 API 限流）
  const web = await fetchWithTimeout(ASSETS_URL(tag))
  if (web && web.ok) {
    try {
      const html = await web.text()
      const m = html.match(/\/releases\/download\/[^"']+\/([^"']+-setup\.exe)/)
      if (m) return `${DOWNLOAD_BASE}/${encodeURIComponent(tag)}/${m[1]}`
    } catch {
      /* 回退到固定模式 */
    }
  }
  // 3) 固定命名模式兜底（发布命名恒为 BepInExManager-<version>-setup.exe）
  return `${DOWNLOAD_BASE}/${encodeURIComponent(tag)}/BepInExManager-${version}-setup.exe`
}

/** 下载最新版 setup.exe 到数据根 cache/（带进度回调），返回本地路径 */
export async function downloadUpdate(
  setupUrl: string,
  onProgress?: (p: UpdateDownloadProgress) => void
): Promise<UpdateDownloadResult> {
  const cacheDir = join(dataRootDir(), 'cache')
  mkdirSync(cacheDir, { recursive: true })
  const fileName = `BepInExManager-${app.getVersion()}-update-setup.exe`
  const dest = join(cacheDir, fileName)

  onProgress?.({ phase: 'download', percent: 0, message: '下载中…' })
  const res = await fetch(setupUrl, {
    headers: { 'User-Agent': UA, Accept: 'application/octet-stream' },
    redirect: 'follow'
  })
  if (!res.ok) {
    throw new Error(`下载失败: HTTP ${res.status}`)
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  const ws = createWriteStream(dest)
  await pipeline(
    Readable.fromWeb(res.body as never).on('data', (chunk: Buffer) => {
      received += chunk.length
      if (total > 0) {
        onProgress?.({
          phase: 'download',
          percent: Math.round((received / total) * 100),
          message: `下载中… ${Math.round((received / total) * 100)}%`
        })
      }
    }),
    ws
  )
  onProgress?.({ phase: 'done', percent: 100, message: '下载完成' })
  return { setupPath: dest, size: existsSync(dest) ? statSync(dest).size : 0 }
}

/**
 * 应用更新：运行 setup.exe 安装包，自动选择当前安装路径。
 * 用户手动完成安装向导后，自行决定是否重启应用。
 */
export function applyUpdate(setupPath: string): UpdateApplyResult {
  if (!isInstalledBuild()) {
    return { ok: false, message: '便携版不支持应用内自动升级，请前往 GitHub 手动下载覆盖' }
  }
  if (!existsSync(setupPath)) {
    return { ok: false, message: `安装包不存在: ${setupPath}` }
  }
  const exePath = app.getPath('exe')
  const installDir = dirname(exePath)
  try {
    // 直接运行安装包，/D= 指定默认安装路径（用户可在向导中修改）
    spawn(setupPath, [`/D=${installDir}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    }).unref()
    return { ok: true, message: `安装器已启动，安装路径: ${installDir}` }
  } catch (e) {
    return { ok: false, message: `启动安装器失败: ${(e as Error).message}` }
  }
}
