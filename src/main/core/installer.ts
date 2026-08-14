/**
 * BepInEx 一键安装/更新
 *
 * 从 GitHub BepInEx/BepInEx releases 下载官方 zip，解压到游戏目录。
 * 支持 BepInEx 5.x（稳定）与 6.x（pre-release，IL2CPP/Mono 变体）。
 *
 * 资产命名（随版本变化，需正则匹配）：
 *   BepInEx 5:  BepInEx_win_x64_5.4.23.5.zip
 *   BepInEx 6:  BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip
 *               BepInEx_UnityIL2CPP_x64_6.0.0-pre.1.zip
 */
import { createWriteStream, readFileSync, statSync, writeFileSync } from 'fs'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { execFileSync } from 'child_process'
import type { BepInExRelease, InstallProgress, UnityRuntime } from '@shared/types'

const REPO_API = 'https://api.github.com/repos/BepInEx/BepInEx/releases'
const REPO = 'BepInEx/BepInEx'
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`
const ATOM_URL = `https://github.com/${REPO}/releases.atom`
const ASSETS_URL = (tag: string): string => `https://github.com/${REPO}/releases/expanded_assets/${encodeURIComponent(tag)}`

export type ProgressCallback = (p: InstallProgress) => void

/** 兜底版本列表：GitHub API 限流/离线时使用。下载 URL 模式固定，不依赖 API。 */
const DEFAULT_RELEASES: BepInExRelease[] = [
  {
    tag: 'v5.4.23.5',
    prerelease: false,
    publishedAt: '2025-01-01',
    assets: [asset('v5.4.23.5', 'BepInEx_win_x64_5.4.23.5.zip')]
  },
  {
    tag: 'v6.0.0-pre.2',
    prerelease: true,
    publishedAt: '2025-01-01',
    assets: [
      asset('v6.0.0-pre.2', 'BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip'),
      asset('v6.0.0-pre.2', 'BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip')
    ]
  }
]

function asset(tag: string, name: string): { name: string; url: string; size: number } {
  return { name, url: `${DOWNLOAD_BASE}/${tag}/${name}`, size: 0 }
}

/** 列出可用 release（含 pre-release），按游戏运行时过滤资产。带 24h 本地缓存。 */
export async function listBepInExReleases(runtime: UnityRuntime): Promise<BepInExRelease[]> {
  const cacheDir = join(process.env.TEMP ?? '.', 'bepinex-manager-cache')
  const cacheFile = join(cacheDir, `releases-${runtime}.json`)

  // 优先读缓存（24h 有效）
  try {
    if (existsSync(cacheFile)) {
      const stat = statSync(cacheFile)
      if (Date.now() - stat.mtimeMs < 24 * 3600 * 1000) {
        return JSON.parse(readFileSync(cacheFile, 'utf8')) as BepInExRelease[]
      }
    }
  } catch {
    /* 缓存损坏则忽略 */
  }

  const res = await fetch(REPO_API + '?per_page=20', { headers: { 'User-Agent': 'bepinex-manager' } })
  if (!res.ok) {
    // 限流/网络失败时：缓存 → GitHub 网页（Atom + expanded_assets，不受 API 限流）→ 内置列表
    try {
      if (existsSync(cacheFile)) {
        return JSON.parse(readFileSync(cacheFile, 'utf8')) as BepInExRelease[]
      }
    } catch {
      /* 无缓存可用 */
    }
    try {
      const web = await fetchReleasesFromWeb(runtime)
      if (web.length > 0) return web
    } catch {
      /* 网页抓取失败则继续回退 */
    }
    return DEFAULT_RELEASES.filter((r) => r.assets.some((a) => isMatchingAsset(a.name, runtime)))
  }
  const data = (await res.json()) as Array<{
    tag_name: string
    prerelease: boolean
    published_at: string
    assets: Array<{ name: string; browser_download_url: string; size: number }>
  }>

  const result = data.map((r) => filterRelease(r, runtime))

  // 写缓存
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(result), 'utf8')
  } catch {
    /* 缓存写入失败不影响功能 */
  }
  return result
}

/** 过滤单个 release（纯函数，便于测试） */
export function filterRelease(
  r: {
    tag_name: string
    prerelease: boolean
    published_at: string
    assets: Array<{ name: string; browser_download_url: string; size: number }>
  },
  runtime: UnityRuntime
): BepInExRelease {
  return {
    tag: r.tag_name,
    prerelease: r.prerelease,
    publishedAt: r.published_at,
    assets: r.assets
      .filter((a) => isMatchingAsset(a.name, runtime))
      .map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
  }
}

/** 判断资产名是否匹配目标运行时（win + x64 + 变体名） */
export function isMatchingAsset(name: string, runtime: UnityRuntime): boolean {
  const lower = name.toLowerCase()
  if (!lower.includes('win')) return false
  if (!(lower.includes('x64') || lower.includes('x86_64'))) return false
  if (runtime === 'il2cpp') {
    return /unity(?:\.|\s)?il2cpp/.test(lower)
  }
  return /unity(?:\.|\s)?mono/.test(lower) || /^bepinex_win_x64/.test(lower)
}

/**
 * 通过 GitHub 网页端点获取 release 列表（不受 API 限流限制）：
 *   1. releases.atom —— 最新 release 的 tag 与发布时间
 *   2. releases/expanded_assets/<tag> —— 每个 release 的资产清单
 */
async function fetchReleasesFromWeb(runtime: UnityRuntime): Promise<BepInExRelease[]> {
  const atom = await fetchText(ATOM_URL)
  // Atom 中每个 entry 形如：
  //   <title>BepInEx v5.4.23.5</title> <updated>2025-xx-xxT..</updated> <link href=".../releases/tag/v5.4.23.5"/>
  const entries: Array<{ tag: string; updated: string }> = []
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g
  let em: RegExpExecArray | null
  while ((em = entryRe.exec(atom)) !== null) {
    const block = em[1]
    const tagMatch = block.match(/releases\/tag\/([^"<]+)/)
    const updated = block.match(/<updated>([^<]+)</)
    if (tagMatch) {
      entries.push({ tag: decodeURIComponent(tagMatch[1]), updated: updated?.[1] ?? '' })
    }
  }

  const releases: BepInExRelease[] = []
  // 并行抓资产清单（限制并发避免被反爬）
  for (const e of entries.slice(0, 12)) {
    const html = await fetchText(ASSETS_URL(e.tag))
    // 资产链接形如：/BepInEx/BepInEx/releases/download/<tag>/<assetName>
    const assets = new Map<string, string>()
    const assetRe = /\/BepInEx\/BepInEx\/releases\/download\/[^"']+\/([^"'<]+)/g
    let am: RegExpExecArray | null
    while ((am = assetRe.exec(html)) !== null) {
      assets.set(am[1], `${DOWNLOAD_BASE}/${encodeURIComponent(e.tag)}/${am[1]}`)
    }
    const list = [...assets.entries()]
      .map(([name, url]) => ({ name, url, size: 0 }))
      .filter((a) => isMatchingAsset(a.name, runtime))
    if (list.length > 0) {
      releases.push({
        tag: e.tag,
        prerelease: /pre|beta|alpha|rc/i.test(e.tag),
        publishedAt: e.updated.slice(0, 10) || 'unknown',
        assets: list
      })
    }
  }
  return releases
}

/** 抓取文本（带 UA，短超时） */
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) bepinex-manager' },
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

/**
 * 下载并安装 BepInEx 到游戏目录
 * @param gameDir 游戏安装目录
 * @param assetUrl 资产下载 URL
 * @param assetName 资产文件名（用于缓存）
 * @param onProgress 进度回调
 */
export async function installBepInEx(
  gameDir: string,
  assetUrl: string,
  assetName: string,
  onProgress?: ProgressCallback
): Promise<string> {
  const cacheDir = join(process.env.TEMP ?? '.', 'bepinex-manager-cache')
  mkdirSync(cacheDir, { recursive: true })
  const zipPath = join(cacheDir, assetName)

  onProgress?.({ phase: 'download', percent: 0, message: '下载中…' })

  // 下载（支持进度）
  const res = await fetch(assetUrl, {
    headers: { 'User-Agent': 'bepinex-manager', Accept: 'application/octet-stream' },
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  const ws = createWriteStream(zipPath)
  await pipeline(
    Readable.fromWeb(res.body as never).on('data', (chunk: Buffer) => {
      received += chunk.length
      if (total > 0) {
        onProgress?.({ phase: 'download', percent: Math.round((received / total) * 80), message: `下载中… ${Math.round((received / total) * 100)}%` })
      }
    }),
    ws
  )

  // 解压（PowerShell Expand-Archive，避免额外依赖；zip 解压到游戏目录根）
  onProgress?.({ phase: 'extract', percent: 85, message: '解压中…' })
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${gameDir}' -Force`
      ],
      { timeout: 300_000, stdio: 'pipe' }
    )
  } catch (e) {
    throw new Error(`解压失败: ${(e as Error).message}`)
  }

  // 清理缓存文件
  try {
    rmSync(zipPath, { force: true })
  } catch {
    /* 忽略清理失败 */
  }

  onProgress?.({ phase: 'done', percent: 100, message: '安装完成' })
  return join(gameDir, 'BepInEx')
}

/** 验证游戏目录是否已存在 BepInEx（安装前检查） */
export function bepinexAlreadyInstalled(gameDir: string): boolean {
  return existsSync(join(gameDir, 'BepInEx'))
}
