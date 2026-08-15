/**
 * Thunderstore 集成：搜索 + 安装
 *
 * 搜索：https://thunderstore.io/api/experimental/package/?limit=30&search=<query>
 *       （带 search 参数的轻量接口，不走全量 46MB index；结果含 latest.download_url）
 * 安装：下载 latest zip → 解压入库（addFilesToLibrary，安全校验）→ 自动装入当前档案
 */
import { rmSync } from 'fs'
import { addFilesToLibrary, copyEntryToProfile } from './library'
import { downloadZip } from './installer'

const UA = 'bepinex-manager'
const SEARCH_URL = 'https://thunderstore.io/api/experimental/package/'

/** Thunderstore 搜索结果条目 */
export interface ThunderstorePackage {
  /** owner-name */
  fullName: string
  name: string
  owner: string
  /** 最新版本号 */
  version: string
  description: string
  /** 依赖（BepInEx-BepInExPack-x.y.z 格式） */
  dependencies: string[]
  /** 最新版本 zip 下载地址 */
  downloadUrl: string
  /** 所属游戏社区（第一个） */
  community: string | null
  packageUrl: string
}

export interface ThunderstoreInstallResult {
  /** 已入库并装入档案的条目 */
  installed: string[]
  /** 跳过/失败的条目（含原因） */
  skipped: string[]
  /** zip 是否成功下载 */
  downloaded: boolean
}

/** 搜索 Thunderstore（客户端过滤由 API search 完成） */
export async function searchThunderstore(query: string): Promise<ThunderstorePackage[]> {
  const q = query.trim()
  if (!q) return []
  const url = `${SEARCH_URL}?limit=30&search=${encodeURIComponent(q)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`Thunderstore 搜索失败: HTTP ${res.status}`)
  const data = (await res.json()) as { results?: unknown[] }
  const results = (data.results ?? []) as Array<{
    full_name?: string
    name?: string
    owner?: string
    package_url?: string
    latest?: {
      version_number?: string
      description?: string
      dependencies?: string[]
      download_url?: string
    }
    community_listings?: Array<{ community?: string }>
  }>
  return results
    .filter((r) => r.latest?.download_url)
    .map((r) => ({
      fullName: r.full_name ?? '',
      name: r.name ?? '',
      owner: r.owner ?? '',
      version: r.latest?.version_number ?? '',
      description: r.latest?.description ?? '',
      dependencies: r.latest?.dependencies ?? [],
      downloadUrl: r.latest?.download_url ?? '',
      community: r.community_listings?.[0]?.community ?? null,
      packageUrl: r.package_url ?? ''
    }))
    .filter((p) => p.downloadUrl)
}

/**
 * 安装 Thunderstore 包：下载 → 解压入库 → 自动装入当前档案
 * @param onProgress 进度回调（phase: download/extract/install/done）
 */
export async function installThunderstorePackage(
  gameDir: string,
  gameName: string,
  pkg: ThunderstorePackage,
  onProgress?: (p: { phase: string; percent: number; message: string }) => void
): Promise<ThunderstoreInstallResult> {
  const result: ThunderstoreInstallResult = { installed: [], skipped: [], downloaded: false }

  // 1) 下载
  const safeName = `${pkg.owner}-${pkg.name}-${pkg.version}`.replace(/[^\w.-]+/g, '_')
  const zipPath = await downloadZip(pkg.downloadUrl, `ts-${safeName}.zip`, (p) =>
    onProgress?.({ phase: 'download', percent: p.percent, message: `下载 ${pkg.fullName}… ${Math.round((p.percent / 80) * 100)}%` })
  )
  result.downloaded = true

  // 2) 入库（zip 安全解压条目化）
  onProgress?.({ phase: 'extract', percent: 85, message: '解压入库…' })
  const addRes = addFilesToLibrary(gameDir, [zipPath])

  // 3) 自动装入当前档案
  onProgress?.({ phase: 'install', percent: 92, message: '装入当前档案…' })
  for (const item of [...addRes.added, ...addRes.updated]) {
    try {
      copyEntryToProfile(gameDir, gameName, item.fileName)
      result.installed.push(item.fileName)
    } catch (err) {
      result.skipped.push(`${item.fileName}（装入档案失败：${(err as Error).message}）`)
    }
  }
  for (const item of [...addRes.ignored, ...addRes.failed]) {
    result.skipped.push(`${item.fileName}（${item.message}）`)
  }

  // 4) 清理下载缓存
  try {
    rmSync(zipPath, { force: true })
  } catch {
    /* 缓存清理失败可忽略 */
  }

  onProgress?.({ phase: 'done', percent: 100, message: `安装完成：${result.installed.length} 个插件已装入档案` })
  return result
}
