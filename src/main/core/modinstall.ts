/**
 * MOD 拖拽安装：把 .dll / .zip 安装到游戏的当前 BepInEx plugins 目录
 *
 * - .dll   → 直接复制到 plugins/（重名覆盖 = 更新插件）
 * - .zip   → 只提取 .dll 条目（保留包内相对结构），跳过危险可执行文件，
 *            路径遍历（zip-slip）与条目数/大小双重防护
 * - 其他扩展名 → 拒绝并提示
 *
 * 安装目标：隔离模式 = 当前档案的 BepInEx/plugins；常规模式 = 游戏目录 BepInEx/plugins。
 * 不执行任何插件代码，只做文件复制（与元数据解析的安全模型一致）。
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import AdmZip from 'adm-zip'
import { detectBepInEx } from './bepinex'
import type { ModInstallResult } from '@shared/types'

/** 危险可执行扩展名：zip 包内遇到直接忽略，绝不落盘 */
const DANGEROUS_EXT = [
  '.exe', '.bat', '.cmd', '.ps1', '.sh', '.py', '.vbs', '.jar',
  '.js', '.msi', '.com', '.scr', '.dll.pdb', '.dll.config'
]

/** 单个 zip 的条目数上限（防 zip bomb） */
const MAX_ZIP_ENTRIES = 2000
/** 单个解压条目的字节上限 */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024

/** 校验并归一化 zip 内路径：返回安全相对路径或 null */
function safeZipPath(entryName: string): string | null {
  let name = entryName.replace(/\\/g, '/')
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null
  const parts = name.split('/')
  if (parts.includes('..')) return null
  return parts.filter((p) => p.length > 0).join(sep)
}

/** 单个文件（dll）安装 */
function installDll(source: string, pluginsDir: string, result: ModInstallResult): void {
  const name = basename(source)
  try {
    const target = join(pluginsDir, name)
    copyFileSync(source, target)
    result.installed.push({ fileName: name, ok: true, message: target })
  } catch (err) {
    result.failed.push({ fileName: name, ok: false, message: (err as Error).message })
  }
}

/** zip 安装：只提取 dll，剥离 BepInEx/plugins 前缀，保留其余相对结构（导出供验证脚本测试） */
export function extractModZip(zipPath: string, pluginsDir: string, result: ModInstallResult): void {
  const zipName = basename(zipPath)
  let zip: AdmZip
  try {
    zip = new AdmZip(zipPath)
  } catch (err) {
    result.failed.push({ fileName: zipName, ok: false, message: `无法打开压缩包：${(err as Error).message}` })
    return
  }

  const entries = zip.getEntries()
  if (entries.length === 0) {
    result.failed.push({ fileName: zipName, ok: false, message: '压缩包为空' })
    return
  }
  if (entries.length > MAX_ZIP_ENTRIES) {
    result.failed.push({ fileName: zipName, ok: false, message: `压缩包条目过多（${entries.length} > ${MAX_ZIP_ENTRIES}），已拒绝` })
    return
  }

  const pluginsRoot = resolve(pluginsDir)
  let installedCount = 0
  const ignoredNames: string[] = []

  for (const entry of entries) {
    if (entry.isDirectory) continue
    const rel = safeZipPath(entry.entryName)
    if (!rel) {
      ignoredNames.push(`${entry.entryName}（路径不安全，已跳过）`)
      continue
    }
    const ext = extname(rel).toLowerCase()
    if (ext !== '.dll') {
      if (DANGEROUS_EXT.some((d) => rel.toLowerCase().endsWith(d))) {
        ignoredNames.push(`${entry.entryName}（危险可执行文件，已拒绝）`)
      }
      // 其余非插件文件（cfg/json/资源等）不安装，避免污染 plugins
      continue
    }

    // 剥离 BepInEx/plugins/ 前缀（社区 zip 常见结构）
    let relPath = rel
    const lower = rel.toLowerCase()
    const marker = 'bepinex' + sep + 'plugins' + sep
    const markerIdx = lower.indexOf(marker)
    if (markerIdx >= 0) {
      relPath = rel.substring(markerIdx + marker.length)
      if (!relPath) continue
    }

    const target = join(pluginsDir, relPath)
    // zip-slip 双保险：目标必须仍在 plugins 目录内
    if (resolve(target) !== pluginsRoot && !resolve(target).startsWith(pluginsRoot + sep)) {
      ignoredNames.push(`${entry.entryName}（越界路径，已跳过）`)
      continue
    }

    try {
      if (entry.header.size > MAX_ENTRY_BYTES) {
        ignoredNames.push(`${entry.entryName}（超过 256MB，已跳过）`)
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      const data = entry.getData()
      if (!data || data.length === 0) {
        ignoredNames.push(`${entry.entryName}（空文件，已跳过）`)
        continue
      }
      writeFileSync(target, data)
      installedCount++
      result.installed.push({ fileName: relPath, ok: true, message: target })
    } catch (err) {
      result.failed.push({ fileName: entry.entryName, ok: false, message: (err as Error).message })
    }
  }

  if (installedCount === 0 && result.failed.length === 0) {
    result.ignored.push({
      fileName: zipName,
      ok: false,
      message: ignoredNames.length ? `压缩包内没有可安装的 dll（${ignoredNames.slice(0, 3).join('；')}${ignoredNames.length > 3 ? '…' : ''}）` : '压缩包内没有可安装的 dll'
    })
  } else if (ignoredNames.length) {
    result.ignored.push({
      fileName: zipName,
      ok: false,
      message: `已跳过 ${ignoredNames.length} 个条目（${ignoredNames.slice(0, 3).join('；')}${ignoredNames.length > 3 ? '…' : ''}）`
    })
  }
}

/**
 * 安装 MOD 文件到游戏当前 BepInEx plugins 目录
 * @param gameDir  游戏根目录（用于定位当前档案/常规 BepInEx）
 * @param filePaths 拖入的文件绝对路径列表（.dll / .zip）
 */
export function installModsToGame(gameDir: string, filePaths: string[]): ModInstallResult {
  const info = detectBepInEx(gameDir)
  if (!info) {
    throw new Error('未检测到 BepInEx：请先安装 BepInEx 或把游戏迁入插件库')
  }
  if (!existsSync(info.pluginsDir)) {
    mkdirSync(info.pluginsDir, { recursive: true })
  }

  const result: ModInstallResult = { installed: [], ignored: [], failed: [] }

  for (const fp of filePaths) {
    if (!fp || !existsSync(fp)) {
      result.failed.push({ fileName: fp || '(空路径)', ok: false, message: '文件不存在' })
      continue
    }
    const ext = extname(fp).toLowerCase()
    if (ext === '.dll') {
      installDll(fp, info.pluginsDir, result)
    } else if (ext === '.zip') {
      extractModZip(fp, info.pluginsDir, result)
    } else {
      result.failed.push({
        fileName: basename(fp),
        ok: false,
        message: `不支持的格式 .${ext}（仅支持 .dll 或 .zip）`
      })
    }
  }
  return result
}
