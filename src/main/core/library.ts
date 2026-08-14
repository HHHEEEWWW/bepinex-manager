/**
 * 插件库（游戏级共享插件池，按游戏分类）
 *
 * 目录结构（隔离模式下）：
 *   <plugin-library>/<gameRoot>/_library/        ← 本游戏的插件库（条目 = 顶层文件或目录）
 *   <plugin-library>/<gameRoot>/<profileId>/BepInEx/plugins/   ← 档案已装入的插件（复制）
 *
 * 交互模型：
 *   - 拖 .dll / .zip 到插件库 → 入库（zip 自动解压、条目化、安全校验）
 *   - 库条目拖进档案插件区    → 复制到当前档案 plugins/（BepInEx 直接加载）
 *   - 档案条目拖到删除区      → 从当前档案删除（插件库保留）
 *   - 首次扫描自动把各档案现有插件收集进库（幂等）
 *
 * 安全模型：zip 路径穿越（zip-slip）拦截、危险可执行文件黑名单、
 * 条目数/单文件大小上限；全程只复制文件，绝不执行插件代码。
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import { createHash } from 'crypto'
import AdmZip from 'adm-zip'
import { detectBepInEx } from './bepinex'
import { currentIsolatedProfile, profileDir } from './isolation'
import { resolvePluginMetadata } from './metadata'
import { findMainDll, dirSize } from './plugins'
import type {
  LibraryAddResult,
  LibraryEntry,
  LibraryScanResult,
  ModInstallItem,
  PluginInfo
} from '@shared/types'

/** 插件库目录名（与档案目录平级，下划线前缀避免与档案 id 冲突） */
export const LIBRARY_DIR_NAME = '_library'

/** 危险可执行扩展名：zip 包内遇到直接忽略，绝不落盘 */
const DANGEROUS_EXT = [
  '.exe', '.bat', '.cmd', '.ps1', '.sh', '.py', '.vbs', '.jar',
  '.js', '.msi', '.com', '.scr'
]

/** 单个 zip 的条目数上限（防 zip bomb） */
const MAX_ZIP_ENTRIES = 2000
/** 单个解压条目的字节上限 */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024

/**
 * 游戏插件库目录（仅隔离模式）。
 * 通过 detectBepInEx 的 rootDir（=<gameRoot>/<profileId>/BepInEx）反推 gameRoot。
 */
export function libraryDirOf(gameDir: string): string | null {
  const info = detectBepInEx(gameDir)
  if (!info || !info.isIsolated) return null
  const gameRoot = dirname(dirname(info.rootDir))
  return join(gameRoot, LIBRARY_DIR_NAME)
}

/** 校验并归一化 zip 内路径：返回安全相对路径或 null */
function safeZipPath(entryName: string): string | null {
  let name = entryName.replace(/\\/g, '/')
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null
  const parts = name.split('/')
  if (parts.includes('..')) return null
  return parts.filter((p) => p.length > 0).join(sep)
}

/** 剥离 zip 内 BepInEx/plugins/ 前缀（社区 zip 常见结构） */
function stripBepinexPluginsPrefix(rel: string): string {
  const lower = rel.toLowerCase()
  const marker = 'bepinex' + sep + 'plugins' + sep
  const idx = lower.indexOf(marker)
  return idx >= 0 ? rel.substring(idx + marker.length) : rel
}

/**
 * 扫描插件库（自动幂等收集现有档案插件），返回条目列表
 * 每条目：relPath=顶层名，meta=主 dll 元数据，installed=当前档案是否已装
 */
export function scanLibrary(gameDir: string, gameName: string): LibraryScanResult {
  const libDir = libraryDirOf(gameDir)
  if (!libDir) throw new Error('游戏不在隔离模式：请先安装 BepInEx 或迁入插件库')
  mkdirSync(libDir, { recursive: true })

  const sync = collectExistingToLibrary(libDir, gameDir, gameName)

  const entries: LibraryEntry[] = []
  if (existsSync(libDir)) {
    for (const item of readdirSync(libDir, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.name === LIBRARY_DIR_NAME) continue
      const full = join(libDir, item.name)
      const isDir = item.isDirectory()
      const mainDll = isDir ? findMainDll(full, true) : item.name.toLowerCase().endsWith('.dll') ? full : null
      entries.push({
        relPath: item.name,
        name: item.name,
        isDir,
        sizeBytes: dirSize(full),
        meta: null,
        metaError: null,
        mainDllName: mainDll ? basename(mainDll) : null,
        installed: false
      })
    }
  }

  // 批量解析元数据（构造临时 PluginInfo 复用解析管线）
  const info = detectBepInEx(gameDir)
  if (!info) throw new Error('游戏不在隔离模式：请先安装 BepInEx 或迁入插件库')
  const infos: PluginInfo[] = entries.map((e) => ({
    id: e.relPath,
    fileName: e.relPath,
    relPath: e.relPath,
    fullPath: join(libDir, e.relPath),
    mainDllPath: e.mainDllName ? join(libDir, e.relPath, e.mainDllName) : null,
    sizeBytes: e.sizeBytes,
    enabled: true,
    meta: null,
    configFile: null,
    note: null,
    metaError: null
  }))
  resolvePluginMetadata(infos, info)

  // 当前档案已装集合（plugins + plugins-disabled 顶层条目名）
  const current = currentIsolatedProfile(gameDir, gameName)
  const installedNames = new Set<string>()
  if (current) {
    const pDir = join(profileDir(gameName, gameDir, current.id), 'BepInEx', 'plugins')
    const dDir = join(profileDir(gameName, gameDir, current.id), 'BepInEx', 'plugins-disabled')
    for (const d of [pDir, dDir]) {
      if (!existsSync(d)) continue
      try {
        for (const it of readdirSync(d, { withFileTypes: true })) {
          if (!it.name.startsWith('.')) installedNames.add(it.name)
        }
      } catch {
        /* 忽略读取失败 */
      }
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const meta = infos[i].meta
    entries[i].meta = meta
    entries[i].metaError = infos[i].metaError
    entries[i].installed = installedNames.has(entries[i].relPath)
    if (meta?.name) entries[i].name = meta.name
  }

  entries.sort((a, b) => (a.installed === b.installed ? a.name.localeCompare(b.name, 'zh') : a.installed ? -1 : 1))

  return { libraryDir: libDir, entries, collected: sync.added, updated: sync.updated }
}

/**
 * 幂等收集：把各档案 plugins / plugins-disabled 顶层条目同步进库。
 * 规则（绝不产生 -2/-3 副本，库始终跟随档案最新内容）：
 *   - 同名条目不存在 → 新增复制
 *   - 同名条目内容相同（SHA-256 指纹）→ 跳过
 *   - 同名条目内容不同（插件升级）→ 覆盖更新，以档案版本为准
 *   - 当前生效档案最后处理（版本优先），空目录/空文件不收集
 * 返回 { added, updated }
 */
export function collectExistingToLibrary(
  libDir: string,
  gameDir: string,
  gameName: string
): { added: number; updated: number } {
  const gameRoot = dirname(libDir)
  if (!existsSync(gameRoot)) return { added: 0, updated: 0 }
  const result = { added: 0, updated: 0 }

  // 档案处理顺序：当前生效档案最后（版本优先胜出）
  const current = currentIsolatedProfile(gameDir, gameName)
  const profileIds: string[] = []
  for (const item of readdirSync(gameRoot, { withFileTypes: true })) {
    if (!item.isDirectory() || item.name.startsWith('.') || item.name === LIBRARY_DIR_NAME) continue
    profileIds.push(item.name)
  }
  profileIds.sort((a, b) => (a === current?.id ? 1 : b === current?.id ? -1 : 0))

  for (const profileId of profileIds) {
    const pluginsDirs = [
      join(gameRoot, profileId, 'BepInEx', 'plugins'),
      join(gameRoot, profileId, 'BepInEx', 'plugins-disabled')
    ]
    for (const srcDir of pluginsDirs) {
      if (!existsSync(srcDir)) continue
      let items
      try {
        items = readdirSync(srcDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const it of items) {
        if (it.name.startsWith('.')) continue
        if (!it.isDirectory() && !it.name.toLowerCase().endsWith('.dll')) continue
        const src = join(srcDir, it.name)
        // 空目录/空文件不收集（无插件内容）
        if (dirSize(src) === 0) continue
        const r = copyToLibrary(src, it.name, libDir, it.isDirectory())
        if (r === 'added') result.added++
        else if (r === 'updated') result.updated++
      }
    }
  }
  return result
}

/** 文件 SHA-256（十六进制） */
function fileHash(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

/** 条目内容指纹：文件 = 自身哈希；目录 = 全部文件（相对名:哈希，排序后拼接） */
function entryFingerprint(p: string, isDir: boolean): string {
  if (!isDir) return fileHash(p)
  const parts: string[] = []
  const walk = (dir: string): void => {
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      const full = join(dir, it.name)
      if (it.isDirectory()) walk(full)
      else if (it.isFile()) parts.push(`${it.name}:${fileHash(full)}`)
    }
  }
  walk(p)
  parts.sort()
  return parts.join('|')
}

/** 复制/更新单个文件或目录到库；返回 'added' | 'updated' | 'skipped' */
function copyToLibrary(src: string, name: string, libDir: string, isDir: boolean): 'added' | 'updated' | 'skipped' {
  const target = join(libDir, name)
  const existed = existsSync(target)
  if (existed) {
    // 内容相同 → 跳过（幂等）
    if (entryFingerprint(src, isDir) === entryFingerprint(target, isDir)) return 'skipped'
    // 内容不同 → 覆盖更新（档案版本胜出，绝不建 -2/-3 副本）
    rmSync(target, { recursive: true, force: true })
  }
  mkdirSync(libDir, { recursive: true })
  try {
    if (isDir) cpSync(src, target, { recursive: true })
    else copyFileSync(src, target)
    return existed ? 'updated' : 'added'
  } catch (err) {
    console.error(`[library] 收集插件失败 ${src}:`, err)
    // 复制失败时清理可能残留的半成品目录
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    return 'skipped'
  }
}

/**
 * 添加文件到插件库：
 *   .dll → 顶层文件条目（重名覆盖 = 更新）
 *   .zip → 条目化：dll 位于顶层 → 每 dll 一条目；位于子目录 → 该目录整体一条目（含资源文件）
 */
export function addFilesToLibrary(gameDir: string, filePaths: string[]): LibraryAddResult {
  const libDir = libraryDirOf(gameDir)
  if (!libDir) throw new Error('游戏不在隔离模式：请先安装 BepInEx 或迁入插件库')
  mkdirSync(libDir, { recursive: true })

  const result: LibraryAddResult = { added: [], updated: [], ignored: [], failed: [] }

  for (const fp of filePaths) {
    if (!fp || !existsSync(fp)) {
      result.failed.push({ fileName: fp || '(空路径)', ok: false, message: '文件不存在' })
      continue
    }
    const ext = extname(fp).toLowerCase()
    if (ext === '.dll') {
      const name = basename(fp)
      const target = join(libDir, name)
      try {
        const existed = existsSync(target)
        copyFileSync(fp, target)
        ;(existed ? result.updated : result.added).push({ fileName: name, ok: true, message: target })
      } catch (err) {
        result.failed.push({ fileName: name, ok: false, message: (err as Error).message })
      }
    } else if (ext === '.zip') {
      extractZipToLibrary(fp, libDir, result)
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

/** zip 条目化入库 */
function extractZipToLibrary(zipPath: string, libDir: string, result: LibraryAddResult): void {
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

  // 第一遍：安全校验 + 归类
  interface Pending { entry: AdmZip.IZipEntry; rel: string; isDll: boolean }
  const pendings: Pending[] = []
  const ignoredNames: string[] = []
  const libRoot = libDir // 目标根（绝对路径校验用）

  for (const entry of entries) {
    if (entry.isDirectory) continue
    const rel = safeZipPath(entry.entryName)
    if (!rel) {
      ignoredNames.push(`${entry.entryName}（路径不安全，已跳过）`)
      continue
    }
    const ext = extname(rel).toLowerCase()
    if (ext === '.dll') {
      pendings.push({ entry, rel: stripBepinexPluginsPrefix(rel), isDll: true })
    } else if (DANGEROUS_EXT.some((d) => rel.toLowerCase().endsWith(d))) {
      ignoredNames.push(`${entry.entryName}（危险可执行文件，已拒绝）`)
    } else {
      // 非 dll 文件：只有属于"目录条目"内部时才提取（第一遍先记下）
      pendings.push({ entry, rel: stripBepinexPluginsPrefix(rel), isDll: false })
    }
  }

  if (pendings.length === 0) {
    result.ignored.push({
      fileName: zipName,
      ok: false,
      message: ignoredNames.length ? `压缩包内没有可安装的文件（${ignoredNames.slice(0, 3).join('；')}${ignoredNames.length > 3 ? '…' : ''}）` : '压缩包内没有可安装的文件'
    })
    return
  }

  // 归类：顶层 dll → 文件条目；其余（dll 在子目录 / 非 dll 资源）→ 按顶层目录分组
  const fileEntries = new Map<string, Pending>() // 顶层文件名 → dll
  const dirEntries = new Map<string, Pending[]>() // 顶层目录名 → 其下所有文件（dll + 资源）
  for (const p of pendings) {
    if (!p.rel) {
      ignoredNames.push(`${p.entry.entryName}（BepInEx/plugins 前缀剥离后为空，已跳过）`)
      continue
    }
    const parts = p.rel.split(sep)
    if (parts.length === 1) {
      if (p.isDll) fileEntries.set(p.rel, p)
      else ignoredNames.push(`${p.entry.entryName}（非插件文件，已忽略）`)
    } else {
      const top = parts[0]
      const list = dirEntries.get(top) ?? []
      list.push(p)
      dirEntries.set(top, list)
    }
  }

  let addedCount = 0
  let updatedCount = 0

  // 文件条目
  for (const [name, p] of fileEntries) {
    const target = join(libDir, name)
    if (resolveOutside(libRoot, target)) {
      ignoredNames.push(`${p.entry.entryName}（越界路径，已跳过）`)
      continue
    }
    try {
      const existed = existsSync(target)
      writeFileSync(target, p.entry.getData())
      ;(existed ? result.updated : result.added).push({ fileName: name, ok: true, message: target })
      if (existed) updatedCount++
      else addedCount++
    } catch (err) {
      result.failed.push({ fileName: p.entry.entryName, ok: false, message: (err as Error).message })
    }
  }

  // 目录条目：整目录提取（dll + 安全资源）
  for (const [top, list] of dirEntries) {
    const targetDir = join(libDir, top)
    if (resolveOutside(libRoot, targetDir)) {
      ignoredNames.push(`${top}（越界路径，已跳过）`)
      continue
    }
    // 写入前判定是否已存在（mkdirSync 会先建目录，不能事后判断）
    const existed = existsSync(targetDir) && dirSize(targetDir) > 0
    let wrote = 0
    for (const p of list) {
      const relPath = p.rel.split(sep).slice(1).join(sep)
      if (!relPath) continue
      const target = join(targetDir, relPath)
      if (resolveOutside(libRoot, target) || resolveOutside(targetDir, target)) {
        ignoredNames.push(`${p.entry.entryName}（越界路径，已跳过）`)
        continue
      }
      if (p.entry.header.size > MAX_ENTRY_BYTES) {
        ignoredNames.push(`${p.entry.entryName}（超过 256MB，已跳过）`)
        continue
      }
      try {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, p.entry.getData())
        wrote++
      } catch (err) {
        result.failed.push({ fileName: p.entry.entryName, ok: false, message: (err as Error).message })
      }
    }
    if (wrote > 0) {
      const item: ModInstallItem = {
        fileName: top,
        ok: true,
        message: targetDir + (existed ? '（已覆盖更新）' : '')
      }
      if (existed) {
        result.updated.push(item)
        updatedCount++
      } else {
        result.added.push(item)
        addedCount++
      }
    }
  }

  if (addedCount + updatedCount === 0 && result.failed.length === 0) {
    result.ignored.push({ fileName: zipName, ok: false, message: '压缩包内没有可安装的 dll' })
  } else if (ignoredNames.length) {
    result.ignored.push({
      fileName: zipName,
      ok: false,
      message: `已跳过 ${ignoredNames.length} 个条目（${ignoredNames.slice(0, 3).join('；')}${ignoredNames.length > 3 ? '…' : ''}）`
    })
  }
}

/** 路径是否越出根目录（zip-slip 双保险） */
function resolveOutside(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  return t !== r && !t.startsWith(r + sep)
}

/**
 * 复制库条目到当前档案 plugins（装入档案）。
 * 重名自动覆盖更新；返回目标绝对路径。
 */
export function copyEntryToProfile(gameDir: string, gameName: string, relPath: string): string {
  const libDir = libraryDirOf(gameDir)
  if (!libDir) throw new Error('游戏不在隔离模式')
  if (!relPath || relPath.includes('..') || relPath.includes('/') || relPath.includes('\\')) {
    throw new Error('非法的条目名')
  }
  const src = join(libDir, relPath)
  if (!existsSync(src)) throw new Error(`插件库中不存在条目「${relPath}」`)

  const current = currentIsolatedProfile(gameDir, gameName)
  if (!current) throw new Error('未找到当前档案')
  const pluginsDir = join(profileDir(gameName, gameDir, current.id), 'BepInEx', 'plugins')
  mkdirSync(pluginsDir, { recursive: true })

  const dst = join(pluginsDir, relPath)
  if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
  const st = statSync(src)
  if (st.isDirectory()) cpSync(src, dst, { recursive: true })
  else copyFileSync(src, dst)
  return dst
}

/**
 * 从当前档案移除条目（插件库保留）。
 * plugins 与 plugins-disabled 两处都清理。
 */
export function removeEntryFromProfile(gameDir: string, gameName: string, relPath: string): boolean {
  if (!relPath || relPath.includes('..') || relPath.includes('/') || relPath.includes('\\')) {
    throw new Error('非法的条目名')
  }
  const current = currentIsolatedProfile(gameDir, gameName)
  if (!current) throw new Error('未找到当前档案')
  const base = join(profileDir(gameName, gameDir, current.id), 'BepInEx')
  let removed = false
  for (const d of ['plugins', 'plugins-disabled']) {
    const target = join(base, d, relPath)
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true })
      removed = true
    }
  }
  return removed
}

/**
 * 从插件库删除条目（文件或目录，不可恢复）。
 * 已装入档案的副本不受影响（档案保留自己的副本）。
 */
export function removeLibraryEntry(gameDir: string, relPath: string): boolean {
  const libDir = libraryDirOf(gameDir)
  if (!libDir) throw new Error('游戏不在隔离模式')
  if (!relPath || relPath.includes('..') || relPath.includes('/') || relPath.includes('\\')) {
    throw new Error('非法的条目名')
  }
  const target = join(libDir, relPath)
  if (!existsSync(target)) throw new Error(`插件库中不存在条目「${relPath}」`)
  rmSync(target, { recursive: true, force: true })
  return true
}
