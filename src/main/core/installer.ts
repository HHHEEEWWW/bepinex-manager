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
import { createWriteStream, readFileSync, writeFileSync, cpSync } from 'fs'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { execFileSync } from 'child_process'
import type { BepInExRelease, InstallProgress, UnityRuntime } from '@shared/types'
import { profileDir, newProfileId, writeMeta, pointDoorstopToProfile } from './isolation'
import { dataRootDir } from './profiles'

const REPO_API = 'https://api.github.com/repos/BepInEx/BepInEx/releases'
const REPO = 'BepInEx/BepInEx'
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`
const ATOM_URL = `https://github.com/${REPO}/releases.atom`
const ASSETS_URL = (tag: string): string => `https://github.com/${REPO}/releases/expanded_assets/${encodeURIComponent(tag)}`
/** BepInEx 官方 CI 构建站（Bleeding Edge 最新构建；GitHub Releases 的 6.x 只有老旧的 pre.2） */
const BUILDS_URL = 'https://builds.bepinex.dev/projects/bepinex_be'

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

/** 列出可用 release（含 pre-release），按游戏运行时过滤资产。BE 构建实时置顶，GitHub 列表带 24h 缓存。 */
export async function listBepInExReleases(runtime: UnityRuntime): Promise<BepInExRelease[]> {
  // 通道 0：BepInEx 官方 CI 构建站（Bleeding Edge 最新构建，支持新 Unity metadata）。
  // 实时抓取不缓存（构建每天更新）：GitHub Releases 的 6.x 仅有 6.0.0-pre.2
  // （Cpp2IL 只支持 metadata 23-29，新游戏 metadata 31 会 InteropManager 初始化失败）。
  const be = await fetchBleedingEdgeBuild(runtime)
  // 通道 1：GitHub API → 缓存 → 网页 → 内置兜底（函数内部处理缓存）
  const github = await fetchGithubReleases(runtime)

  const result = be ? [be, ...github] : github
  if (result.length === 0) return result

  // GitHub 列表写缓存（BE 不缓存）
  const cacheDir = join(dataRootDir(), 'cache')
  const cacheFile = join(cacheDir, `releases-${runtime}.json`)
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(github), 'utf8')
  } catch {
    /* 缓存写入失败不影响功能 */
  }
  return result
}

/** 通道：GitHub API → 缓存 → 网页（Atom + expanded_assets）→ 内置兜底 */
async function fetchGithubReleases(runtime: UnityRuntime): Promise<BepInExRelease[]> {
  const cacheFile = join(dataRootDir(), 'cache', `releases-${runtime}.json`)
  const res = await fetch(REPO_API + '?per_page=20', { headers: { 'User-Agent': 'bepinex-manager' } })
  if (!res.ok) {
    // 限流/网络失败时：缓存 → GitHub 网页（Atom + expanded_assets，不受 API 限流）→ 内置列表
    try {
      if (existsSync(cacheFile)) {
        const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as BepInExRelease[]
        return cached.filter((r) => r.assets.length > 0)
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

  return data.map((r) => filterRelease(r, runtime)).filter((r) => r.assets.length > 0)
}

/**
 * 通道：BepInEx 官方 CI 构建站（builds.bepinex.dev）
 * 抓取最新 Bleeding Edge 构建（如 be.785）的 win-x64 zip，作为置顶推荐版本。
 * 该通道不受 GitHub API 限流；失败返回 null（不影响其他通道）。
 */
async function fetchBleedingEdgeBuild(runtime: UnityRuntime): Promise<BepInExRelease | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    const res = await fetch(BUILDS_URL, {
      headers: { 'User-Agent': 'bepinex-manager', Accept: 'text/html' },
      signal: controller.signal
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const html = await res.text()

    // 第一个 artifact-item = 最新构建；提取目标运行时 zip 链接
    const first = html.match(/<div class="artifact-item">([\s\S]*?)<\/div>\s*<div class="artifact-item">/)
    const block = first ? first[1] : html
    const target = runtime === 'il2cpp' ? 'Unity.IL2CPP-win-x64' : 'Unity.Mono-win-x64'
    const link = block.match(new RegExp(`href="(/projects/bepinex_be/\\d+/[^"]*${target}[^"]*\\.zip)"`))
    if (!link) return null
    const name = decodeURIComponent(link[1].split('/').pop() ?? '')
    const url = 'https://builds.bepinex.dev' + link[1]
    const build = name.match(/be\.(\d+)/)
    const tag = build ? `v6.0.0-be.${build[1]}` : 'v6.0.0-be'
    return {
      tag,
      prerelease: true,
      publishedAt: '',
      assets: [{ name, url, size: 0 }]
    }
  } catch {
    return null
  }
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

/** 下载 zip 到缓存目录（数据根内 cache/，不散落系统临时目录；带进度回调），返回 zip 路径 */
export async function downloadZip(
  assetUrl: string,
  assetName: string,
  onProgress?: ProgressCallback
): Promise<string> {
  const cacheDir = join(dataRootDir(), 'cache')
  mkdirSync(cacheDir, { recursive: true })
  const zipPath = join(cacheDir, assetName)

  onProgress?.({ phase: 'download', percent: 0, message: '下载中…' })
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
        onProgress?.({
          phase: 'download',
          percent: Math.round((received / total) * 80),
          message: `下载中… ${Math.round((received / total) * 100)}%`
        })
      }
    }),
    ws
  )
  return zipPath
}

/** 解压 zip 到指定目录（PowerShell Expand-Archive，避免额外依赖） */
function extractZip(zipPath: string, destDir: string): void {
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`
    ],
    { timeout: 300_000, stdio: 'pipe' }
  )
}

/**
 * 下载并安装 BepInEx 到游戏目录（常规模式）
 */
export async function installBepInEx(
  gameDir: string,
  assetUrl: string,
  assetName: string,
  onProgress?: ProgressCallback
): Promise<string> {
  const zipPath = await downloadZip(assetUrl, assetName, onProgress)

  // 解压到游戏目录根
  onProgress?.({ phase: 'extract', percent: 85, message: '解压中…' })
  try {
    extractZip(zipPath, gameDir)
  } catch (e) {
    throw new Error(`解压失败: ${(e as Error).message}`)
  }

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

/**
 * 下载 BepInEx 并直装到插件库（方案 A，推荐）：
 *   - BepInEx 整树解压到插件库：<dataRoot>/plugins/<gameSlug>/<profileId>/BepInEx/
 *   - 游戏目录只放注入件（winhttp.dll、.doorstop_version）
 *   - doorstop_config.ini 指向插件库 preloader → Steam 直接启动即生效
 */
export async function installBepInExToLibrary(
  gameDir: string,
  gameName: string,
  assetUrl: string,
  assetName: string,
  onProgress?: ProgressCallback
): Promise<{ profileId: string; target: string }> {
  const zipPath = await downloadZip(assetUrl, assetName, onProgress)

  // 解压到临时目录，分离 BepInEx/ 与注入件
  onProgress?.({ phase: 'extract', percent: 85, message: '解压中…' })
  const tmpDir = join(dataRootDir(), 'cache', 'tmp-extract-' + Date.now())
  mkdirSync(tmpDir, { recursive: true })
  try {
    extractZip(zipPath, tmpDir)
  } catch (e) {
    throw new Error(`解压失败: ${(e as Error).message}`)
  }

  const profileId = newProfileId()
  const destBep = join(profileDir(gameName, gameDir, profileId), 'BepInEx')
  try {
    // 1. BepInEx 整树 → 插件库
    const srcBep = join(tmpDir, 'BepInEx')
    if (!existsSync(srcBep)) throw new Error('压缩包内未找到 BepInEx 目录')
    mkdirSync(dirname(destBep), { recursive: true })
    cpSync(srcBep, destBep, { recursive: true })

    // 2. 注入件 → 游戏目录：
    //    - doorstop_config.ini 用 zip 自带模板（含 [UnityMono]/[Il2Cpp] 完整配置节），随后只改 target
    //    - winhttp.dll / .doorstop_version 同源复制
    for (const inj of ['winhttp.dll', '.doorstop_version', 'doorstop_config.ini']) {
      const src = join(tmpDir, inj)
      if (!existsSync(src)) continue
      cpSync(src, join(gameDir, inj), { force: true })
    }
    // 3. dotnet/ 运行时目录（BepInEx 6 IL2CPP 加载插件必需：Doorstop 按 coreclr_path=dotnet\coreclr.dll 加载）
    const srcDotnet = join(tmpDir, 'dotnet')
    if (existsSync(srcDotnet) && !existsSync(join(gameDir, 'dotnet'))) {
      cpSync(srcDotnet, join(gameDir, 'dotnet'), { recursive: true })
    }
    if (!existsSync(join(gameDir, 'winhttp.dll'))) {
      throw new Error('压缩包内未包含 winhttp.dll（Doorstop 注入器）')
    }
    if (!existsSync(join(gameDir, 'dotnet', 'coreclr.dll'))) {
      throw new Error('压缩包内未包含 dotnet/coreclr.dll（IL2CPP 运行时），无法建立隔离模式')
    }

    // 3. 元数据 + doorstop 指向插件库
    writeMeta(gameName, gameDir, profileId, {
      name: '默认',
      gameName,
      createdAt: new Date().toISOString()
    })
    const target = pointDoorstopToProfile(gameDir, destBep)
    onProgress?.({ phase: 'done', percent: 100, message: '安装完成（插件库模式）' })
    return { profileId, target }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
      rmSync(zipPath, { force: true })
    } catch {
      /* 忽略清理失败 */
    }
  }
}
