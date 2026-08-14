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
import { join, relative, dirname } from 'path'
import type { BepInExInfo, GameScanResult, PluginConflict, PluginInfo } from '@shared/types'
import { resolvePluginMetadata } from './metadata'

export const DISABLED_DIR_NAME = 'plugins-disabled'

/** 扫描一个游戏的插件列表（启用 + 禁用合并） */
export function scanPlugins(bepinex: BepInExInfo): GameScanResult {
  const pluginsDir = bepinex.pluginsDir
  const disabledDir = join(bepinex.gameDir, 'BepInEx', DISABLED_DIR_NAME)

  const enabled: PluginInfo[] = collectDlls(pluginsDir, pluginsDir, true)
  const disabled: PluginInfo[] = collectDlls(disabledDir, disabledDir, false)

  const all = [...enabled, ...disabled]
  // 解析元数据（批量一次调用，dll 多时也能接受）
  resolvePluginMetadata(all, bepinex)

  // 关联 cfg（文件名 = GUID.cfg）
  for (const p of all) {
    if (p.meta?.guid) {
      const cfg = join(bepinex.configDir, `${p.meta.guid}.cfg`)
      p.configFile = existsSync(cfg) ? cfg : null
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
  const disabledDir = join(bepinex.gameDir, 'BepInEx', DISABLED_DIR_NAME)

  const srcDir = enabled ? disabledDir : pluginsDir
  const dstDir = enabled ? pluginsDir : disabledDir
  const src = join(srcDir, pluginId)
  if (!existsSync(src)) throw new Error(`插件文件不存在: ${src}`)

  const dst = join(dstDir, pluginId)
  mkdirSync(dirname(dst), { recursive: true })
  renameSync(src, dst)
  return enabled
}

/** 收集目录下所有 dll（递归，忽略隐藏目录） */
function collectDlls(rootDir: string, baseDir: string, enabled: boolean): PluginInfo[] {
  if (!existsSync(rootDir)) return []
  const result: PluginInfo[] = []
  const walk = (dir: string): void => {
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === DISABLED_DIR_NAME) continue
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        walk(full)
      } else if (item.name.toLowerCase().endsWith('.dll')) {
        const rel = relative(baseDir, full).replace(/\\/g, '/')
        result.push({
          id: rel,
          fileName: item.name,
          relPath: rel,
          fullPath: full,
          sizeBytes: statSync(full).size,
          enabled,
          meta: null,
          configFile: null,
          metaError: null
        })
      }
    }
  }
  walk(rootDir)
  return result
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
