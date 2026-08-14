/**
 * 插件扫描与启停
 *
 * 目录约定：
 *   <gameDir>/BepInEx/plugins/          启用中的插件（BepInEx 只加载这里）
 *   <gameDir>/BepInEx/plugins-disabled/ 被禁用的插件（与 plugins 平级，BepInEx 不扫描）
 *
 * 禁用 = 把 dll 从 plugins 移到 plugins-disabled（保持相对目录结构），启用 = 反向移动。
 * 该方案跨 BepInEx 5/6 兼容，不修改任何游戏文件。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs'
import { join, dirname } from 'path'
import type { BepInExInfo, GameScanResult, PluginConflict, PluginInfo } from '@shared/types'
import { resolvePluginMetadata } from './metadata'
import { getModNote } from './modnotes'

export const DISABLED_DIR_NAME = 'plugins-disabled'

/**
 * 禁用目录位置：与 pluginsDir 同根（跟随 BepInEx 数据根）。
 * 常规模式 = <游戏目录>/BepInEx/plugins-disabled；
 * 隔离模式 = <插件库档案>/BepInEx/plugins-disabled（与 plugins 同盘，避免跨盘 rename）。
 */
export function disabledDirOf(bepinex: BepInExInfo): string {
  return join(bepinex.rootDir, DISABLED_DIR_NAME)
}

/** 扫描一个游戏的插件列表（启用 + 禁用合并，条目粒度：一个 mod = 一个顶层文件/目录） */
export function scanPlugins(bepinex: BepInExInfo): GameScanResult {
  const pluginsDir = bepinex.pluginsDir
  const disabledDir = disabledDirOf(bepinex)

  const enabled: PluginInfo[] = collectEntries(pluginsDir, true)
  const disabled: PluginInfo[] = collectEntries(disabledDir, false)

  const all = [...enabled, ...disabled]
  // 解析元数据（批量一次调用，dll 多时也能接受）
  resolvePluginMetadata(all, bepinex)

  // 关联 cfg（文件名 = GUID.cfg）+ mod 说明
  for (const p of all) {
    if (p.meta?.guid) {
      const cfg = join(bepinex.configDir, `${p.meta.guid}.cfg`)
      p.configFile = existsSync(cfg) ? cfg : null
      p.note = getModNote(p.meta.guid)
    }
  }

  const conflicts = detectConflicts(all)

  return {
    game: {
      id: hashId(bepinex.gameDir),
      name: bepinex.gameDir.split(/[\\/]/).filter(Boolean).pop() ?? '',
      gameDir: bepinex.gameDir,
      source: 'manual',
      bepinex,
      compatible: true,
      engine: bepinex.isMono ? 'Unity (Mono)' : 'Unity (IL2CPP)'
    },
    plugins: all,
    hasDisabledDir: existsSync(disabledDir),
    conflicts
  }
}

/**
 * 冲突检测：
 *   1. duplicate-guid —— 两个启用插件声明相同 GUID（BepInEx 只加载先到的那个，另一个失效）
 *   2. duplicate-file —— 同名 dll 出现在多个插件目录（可能互相覆盖/干扰）
 */
export function detectConflicts(plugins: PluginInfo[]): PluginConflict[] {
  const conflicts: PluginConflict[] = []

  // GUID 重复（只统计启用的，禁用中的不参与加载）
  const enabled = plugins.filter((p) => p.enabled && p.meta?.guid)
  const byGuid = new Map<string, PluginInfo[]>()
  for (const p of enabled) {
    const list = byGuid.get(p.meta!.guid) ?? []
    list.push(p)
    byGuid.set(p.meta!.guid, list)
  }
  for (const [guid, list] of byGuid) {
    if (list.length > 1) {
      conflicts.push({
        kind: 'duplicate-guid',
        message: `多个插件使用相同 GUID「${guid}」，BepInEx 只会加载其中一个，其余失效：${list
          .map((p) => p.fileName)
          .join('、')}`,
        pluginIds: list.map((p) => p.id)
      })
    }
  }

  // 同名 dll 重复（跨目录）
  const byFileName = new Map<string, PluginInfo[]>()
  for (const p of plugins) {
    const key = p.fileName.toLowerCase()
    const list = byFileName.get(key) ?? []
    list.push(p)
    byFileName.set(key, list)
  }
  for (const [name, list] of byFileName) {
    if (list.length > 1) {
      const ids = list.map((p) => p.id)
      conflicts.push({
        kind: 'duplicate-file',
        message: `多个插件目录包含同名文件「${name}」，可能相互覆盖或干扰：${ids.join('、')}`,
        pluginIds: ids
      })
    }
  }

  return conflicts
}

/** 启用/禁用插件。返回新状态。 */
export function setPluginEnabled(bepinex: BepInExInfo, pluginId: string, enabled: boolean): boolean {
  const pluginsDir = bepinex.pluginsDir
  const disabledDir = disabledDirOf(bepinex)

  const srcDir = enabled ? disabledDir : pluginsDir
  const dstDir = enabled ? pluginsDir : disabledDir
  const src = join(srcDir, pluginId)
  if (!existsSync(src)) throw new Error(`插件文件不存在: ${src}`)

  const dst = join(dstDir, pluginId)
  mkdirSync(dirname(dst), { recursive: true })
  renameSync(src, dst)
  return enabled
}

/** 收集目录下所有插件条目（顶层文件 dll 或目录，忽略隐藏/禁用目录） */
function collectEntries(rootDir: string, enabled: boolean): PluginInfo[] {
  if (!existsSync(rootDir)) return []
  const result: PluginInfo[] = []
  let items
  try {
    items = readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const item of items) {
    if (item.name.startsWith('.') || item.name === DISABLED_DIR_NAME) continue
    const full = join(rootDir, item.name)
    const isDir = item.isDirectory()
    // 顶层散文件只收 dll；目录整体视为一个插件条目
    if (!isDir && !item.name.toLowerCase().endsWith('.dll')) continue
    result.push({
      id: item.name,
      fileName: item.name,
      relPath: item.name,
      fullPath: full,
      mainDllPath: findMainDll(full, isDir),
      sizeBytes: dirSize(full),
      enabled,
      meta: null,
      configFile: null,
      note: null,
      metaError: null
    })
  }
  return result
}

/**
 * 条目内主 dll：目录 → 顶层优先取第一个 dll，顶层没有再递归子目录；
 * 文件 → 自身（须为 dll）。
 */
export function findMainDll(entryPath: string, isDir: boolean): string | null {
  if (!isDir) {
    return entryPath.toLowerCase().endsWith('.dll') ? entryPath : null
  }
  const walk = (dir: string, deep: boolean): string | null => {
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    // 顶层扫描
    for (const it of items) {
      if (it.isFile() && it.name.toLowerCase().endsWith('.dll')) return join(dir, it.name)
    }
    if (!deep) return null
    for (const it of items) {
      if (it.isDirectory() && !it.name.startsWith('.')) {
        const hit = walk(join(dir, it.name), true)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(entryPath, true)
}

/** 文件或目录总大小 */
export function dirSize(target: string): number {
  try {
    const st = statSync(target)
    if (st.isFile()) return st.size
    let total = 0
    const walk = (dir: string): void => {
      for (const it of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, it.name)
        if (it.isDirectory()) walk(full)
        else if (it.isFile()) total += statSync(full).size
      }
    }
    walk(target)
    return total
  } catch {
    return 0
  }
}

/** 目录路径 → 稳定 id */
function hashId(path: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'g' + (h >>> 0).toString(16)
}
