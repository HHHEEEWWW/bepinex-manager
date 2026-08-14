/**
 * 检查更新：查询 GitHub Releases API 与当前版本比较
 *
 * 接口：https://api.github.com/repos/HHHEEEWWW/bepinex-manager/releases/latest
 * 未认证 API 限流 60 次/小时，做 5 分钟内存缓存。
 * 失败不阻塞使用：返回 error 字段，由 UI 提示。
 */
import { app } from 'electron'
import type { UpdateCheckResult } from '@shared/types'

const REPO = 'HHHEEEWWW/bepinex-manager'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
/** 缓存时长（毫秒）：5 分钟 */
const CACHE_TTL = 5 * 60 * 1000

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

/** 检查更新（5 分钟缓存） */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = app.getVersion()

  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return { ...cached.result, current }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const res = await fetch(API_URL, {
      headers: { 'User-Agent': 'bepinex-manager', Accept: 'application/vnd.github+json' },
      signal: controller.signal
    })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`)
    const data = (await res.json()) as {
      tag_name?: string
      html_url?: string
      body?: string | null
      name?: string | null
    }
    const latest = String(data.tag_name ?? '').replace(/^v/i, '')
    if (!latest) throw new Error('Release 数据缺少版本号')
    const hasUpdate = compareVersions(latest, current) > 0
    const result: UpdateCheckResult = {
      current,
      latest,
      hasUpdate,
      url: data.html_url ?? null,
      notes: data.body || data.name || null,
      error: null
    }
    cached = { at: Date.now(), result }
    return result
  } catch (e) {
    return { current, latest: null, hasUpdate: false, url: null, notes: null, error: String((e as Error).message ?? e) }
  }
}
