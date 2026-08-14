/**
 * Profile 档案系统（v1）
 *
 * 设计：Profile = 插件启停状态快照 + 元信息。
 *   - 创建：把当前启停状态存为快照
 *   - 应用：把插件状态调整为快照（移动 dll，逐项操作，失败自动回滚）
 *   - 与 r2modman 的"整框架隔离"不同：我们只动 plugins 目录内的 dll，
 *     不触碰 BepInEx 框架本体，跨 BepInEx 5/6 兼容，切换风险最小。
 *
 * 存储：<userData>/profiles.json（JSON，UTF-8 无 BOM）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import type { BepInExInfo, ProfileDef, ProfilesStore } from '@shared/types'
import { scanPlugins, setPluginEnabled } from './plugins'

/** 管理器数据根目录（可被环境变量覆盖，独立验证用） */
export function dataRootDir(): string {
  return (
    process.env.BEPINEX_MANAGER_DATA_DIR ||
    join(process.env.APPDATA ?? process.env.HOME ?? '.', 'bepinex-manager')
  )
}

/** Profile 数据文件路径（可被环境变量覆盖，独立验证用） */
export function profilesFilePath(): string {
  return join(dataRootDir(), 'profiles.json')
}

const emptyStore = (): ProfilesStore => ({ games: {} })

function loadStore(): ProfilesStore {
  const file = profilesFilePath()
  if (!existsSync(file)) return emptyStore()
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ProfilesStore
  } catch {
    return emptyStore()
  }
}

function saveStore(store: ProfilesStore): void {
  const file = profilesFilePath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')
}

function gameKey(gameDir: string): string {
  return gameDir.toLowerCase().replace(/[\\/]+$/, '')
}

/** 列出某游戏的档案 */
export function listProfiles(gameDir: string): ProfileDef[] {
  const store = loadStore()
  return store.games[gameKey(gameDir)]?.profiles ?? []
}

/** 创建档案（快照当前启停状态） */
export function createProfile(gameDir: string, name: string, states: Record<string, boolean>): ProfileDef {
  const store = loadStore()
  const key = gameKey(gameDir)
  const entry = (store.games[key] ??= { currentProfileId: null, profiles: [] })
  const profile: ProfileDef = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    createdAt: new Date().toISOString(),
    pluginStates: { ...states }
  }
  entry.profiles.push(profile)
  if (!entry.currentProfileId) entry.currentProfileId = profile.id
  saveStore(store)
  return profile
}

/** 删除档案 */
export function deleteProfile(gameDir: string, profileId: string): void {
  const store = loadStore()
  const key = gameKey(gameDir)
  const entry = store.games[key]
  if (!entry) return
  entry.profiles = entry.profiles.filter((p) => p.id !== profileId)
  if (entry.currentProfileId === profileId) entry.currentProfileId = entry.profiles[0]?.id ?? null
  if (entry.profiles.length === 0) delete store.games[key]
  saveStore(store)
}

/** 重命名档案 */
export function renameProfile(gameDir: string, profileId: string, name: string): ProfileDef | null {
  const store = loadStore()
  const entry = store.games[gameKey(gameDir)]
  const profile = entry?.profiles.find((p) => p.id === profileId)
  if (!profile) return null
  profile.name = name
  saveStore(store)
  return profile
}

/** 设置当前档案标记（不改变插件状态） */
export function setCurrentProfile(gameDir: string, profileId: string): void {
  const store = loadStore()
  const entry = store.games[gameKey(gameDir)]
  if (!entry) return
  entry.currentProfileId = profileId
  saveStore(store)
}

/** 应用档案：把插件启停状态调整为快照。返回操作记录；失败自动回滚。 */
export function applyProfile(
  bepinex: BepInExInfo,
  profileId: string
): { applied: number; rolledBack: number; changes: string[] } {
  const store = loadStore()
  const entry = store.games[gameKey(bepinex.gameDir)]
  const profile = entry?.profiles.find((p) => p.id === profileId)
  if (!profile) throw new Error(`档案不存在: ${profileId}`)

  // 当前状态
  const current = scanPlugins(bepinex)
  const currentStates: Record<string, boolean> = {}
  for (const p of current.plugins) currentStates[p.id] = p.enabled

  // 计算差异（只处理快照中存在的项；快照外的插件不动，避免误伤新装插件）
  const ops: Array<{ id: string; target: boolean; reverted: boolean }> = []
  for (const [relPath, target] of Object.entries(profile.pluginStates)) {
    const cur = currentStates[relPath]
    if (cur === undefined) continue // 插件已不存在
    if (cur !== target) ops.push({ id: relPath, target, reverted: false })
  }

  const changes: string[] = []
  let applied = 0
  let rolledBack = 0

  for (const op of ops) {
    try {
      setPluginEnabled(bepinex, op.id, op.target)
      applied++
      changes.push(`${op.target ? '启用' : '禁用'} ${op.id}`)
    } catch (e) {
      // 回滚已执行的操作
      for (const done of ops) {
        if (done.reverted || !changes.some((c) => c.includes(done.id))) continue
        try {
          setPluginEnabled(bepinex, done.id, !done.target)
          done.reverted = true
          rolledBack++
          changes.push(`回滚 ${done.id}`)
        } catch {
          /* 回滚失败仅记录 */
        }
      }
      throw new Error(`应用档案失败（已回滚 ${rolledBack} 项）: ${e}`)
    }
  }

  if (entry) entry.currentProfileId = profileId
  saveStore(store)
  return { applied, rolledBack, changes }
}
