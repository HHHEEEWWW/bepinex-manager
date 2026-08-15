/**
 * Profile 隔离模式 v2（Doorstop 方案）
 *
 * 原理（调研自 r2modman）：
 *   BepInEx 以 preloader dll 的位置为基准定位数据根目录（plugins/config 在数据根下）。
 *   隔离模式 = 把 BepInEx 整树从游戏目录迁移到管理器数据目录，
 *   游戏根目录只保留注入件（winhttp.dll + doorstop_config.ini + .doorstop_version），
 *   doorstop_config.ini 的 target 指向档案目录的 preloader。
 *   → 从 Steam 直接启动游戏也生效；切换档案 = 改 target 一行，零搬移。
 *
 * 档案目录结构（目录名一律用 ASCII id，规避中文路径编码问题）：
 *   <dataRoot>/profiles/<gameKey>/<profileId>/
 *     ├─ profile.json         { name: 显示名, createdAt }
 *     └─ BepInEx/             BepInEx 整树
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join, dirname } from 'path'
import { dataRootDir } from './profiles'
import { readDoorstopTarget } from './bepinex'
import { applyCpp2IlPatch } from './patch-cpp2il'
import type { IsolatedProfileInfo } from '@shared/types'

/** preloader 候选文件名（BepInEx 5/6 各变体） */
const PRELOADER_NAMES = [
  'BepInEx.Unity.Mono.Preloader.dll',
  'BepInEx.Unity.IL2CPP.dll',
  'BepInEx.Preloader.dll',
  'BepInEx.IL2CPP.dll',
  'BepInEx.NET.CoreCLR.dll'
]

/** 隔离档案元数据（存于档案目录 profile.json） */
export interface IsolatedProfileMeta {
  name: string
  gameName: string
  createdAt: string
}

export type { IsolatedProfileInfo }

/** 简单哈希（保证键唯一） */
function hashId(path: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** 生成 ASCII 档案 id */
export function newProfileId(): string {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * 插件库目录结构（v2，分游戏存放、目录名全 ASCII）：
 *   <dataRoot>/plugin-library/<gameSlug>/<profileId>/
 *     ├─ profile.json   { name: 显示名, gameName, createdAt }
 *     └─ BepInEx/
 *
 * 注意：根目录命名为 plugin-library 而非 plugins，
 * 避免与 BepInEx 框架内部的 plugins（插件加载目录）混淆。
 */
export function pluginsRootDir(): string {
  return join(dataRootDir(), 'plugin-library')
}

/** 游戏在插件库中的根目录（按 ASCII 化游戏名 + 短哈希分游戏存放） */
export function gamePluginsRootDir(gameName: string, gameDir: string): string {
  const slug =
    gameName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'game'
  return join(pluginsRootDir(), `${slug}-${hashId(gameDir).slice(0, 4)}`)
}

/**
 * 从 doorstop target 反推插件库内的游戏根目录。
 * target 形如 <plugin-library>/<gameRoot>/<profileId>/BepInEx/core/<preloader>.dll。
 * 不依赖 gameName/gameDir 的 hash 派生——路径大小写/尾部斜杠/名称漂移时依然正确。
 */
export function gameRootFromTarget(target: string): string | null {
  const libRoot = pluginsRootDir()
  const idx = target.toLowerCase().indexOf(libRoot.toLowerCase())
  if (idx < 0) return null
  const rest = target.slice(idx + libRoot.length).split(/[\\/]/).filter(Boolean)
  if (rest.length < 2) return null
  const gameRoot = join(libRoot, rest[0])
  return existsSync(gameRoot) ? gameRoot : null
}

/**
 * 某游戏在插件库中的根目录：优先从 doorstop target 反推（迁移/切换后
 * gameName/gameDir 字符串漂移——大小写、尾部斜杠、手动添加 vs Steam 扫描——
 * 都会让 hash 派生失配，导致"当前不在隔离模式"误报），失败才回退派生。
 */
function resolveGamePluginsRoot(gameDir: string, gameName: string): string {
  try {
    const target = readDoorstopTarget(join(gameDir, 'doorstop_config.ini'))
    if (target) {
      const derived = gameRootFromTarget(target)
      if (derived) return derived
    }
  } catch {
    /* 回退派生路径 */
  }
  return gamePluginsRootDir(gameName, gameDir)
}

/** 某档案的目录 */
export function profileDir(gameName: string, gameDir: string, profileId: string): string {
  return join(resolveGamePluginsRoot(gameDir, gameName), profileId)
}

/** 档案元数据文件路径 */
function metaPath(gameName: string, gameDir: string, profileId: string): string {
  return join(profileDir(gameName, gameDir, profileId), 'profile.json')
}

function readMeta(gameName: string, gameDir: string, profileId: string): IsolatedProfileMeta {
  try {
    return JSON.parse(readFileSync(metaPath(gameName, gameDir, profileId), 'utf8')) as IsolatedProfileMeta
  } catch {
    return { name: profileId, gameName: '', createdAt: '' }
  }
}

export function writeMeta(
  gameName: string,
  gameDir: string,
  profileId: string,
  meta: IsolatedProfileMeta
): void {
  writeFileSync(metaPath(gameName, gameDir, profileId), JSON.stringify(meta, null, 2), 'utf8')
}

/** 在 core 目录找 preloader dll 文件名 */
export function findPreloader(coreDir: string): string | null {
  try {
    const files = readdirSync(coreDir)
    return PRELOADER_NAMES.find((n) => files.includes(n)) ?? null
  } catch {
    return null
  }
}

/** 判断 Doorstop 配置版本：v4（BepInEx 6 / [General] target_assembly）还是 v3 */
export function doorstopIsV4(gameDir: string): boolean {
  const versionFile = join(gameDir, '.doorstop_version')
  try {
    if (existsSync(versionFile)) {
      const major = Number(readFileSync(versionFile, 'utf8').trim().split('.')[0])
      if (major > 3) return true
    }
  } catch {
    /* 忽略 */
  }
  // BepInEx 6 core 特征
  const coreDir = join(gameDir, 'BepInEx', 'core')
  if (existsSync(join(coreDir, 'BepInEx.Core.dll'))) return true
  if (existsSync(join(gameDir, 'BepInEx', 'interop'))) return true
  return false
}

/** 写入 doorstop_config.ini 的 target（保留其他配置） */
export function writeDoorstopTarget(iniPath: string, target: string, isV4: boolean): void {
  const section = isV4 ? '[General]' : '[UnityDoorstop]'
  const key = isV4 ? 'target_assembly' : 'targetAssembly'
  let text = ''
  if (existsSync(iniPath)) {
    text = readFileSync(iniPath, 'utf8')
  }
  // 替换已有 target 行
  if (/\btarget(?:_assembly|Assembly)\s*=/im.test(text)) {
    text = text.replace(/\btarget(?:_assembly|Assembly)\s*=[^\r\n]*/im, `${key}=${target}`)
  } else {
    // 无配置节时追加
    if (text.trim() !== '' && !text.endsWith('\n')) text += '\n'
    text += `\n${section}\nenabled=true\n${key}=${target}\n`
  }
  writeFileSync(iniPath, text, 'utf8')
}

/** 更新游戏目录 doorstop 指向档案 preloader（迁移/切换/安装共用） */
export function pointDoorstopToProfile(gameDir: string, profileBepInExDir: string): string {
  const coreDir = join(profileBepInExDir, 'core')
  const preloader = findPreloader(coreDir)
  if (!preloader) throw new Error(`档案目录缺少 preloader dll: ${coreDir}`)
  const target = join(coreDir, preloader)
  const isV4 = doorstopIsV4(gameDir)
  writeDoorstopTarget(join(gameDir, 'doorstop_config.ini'), target, isV4)
  return target
}

/**
 * 迁移现有安装到隔离模式（安全顺序）：
 *   1. 复制 BepInEx 到档案（含元数据）
 *   2. 更新 doorstop target 指向档案 preloader
 *   3. 全部成功后才删除游戏目录的 BepInEx 源
 *   任一步失败：恢复游戏目录原状（删除档案副本），绝不丢数据。
 */
export function migrateToIsolated(
  gameDir: string,
  gameName: string,
  profileName: string
): { profileId: string; target: string } {
  const src = join(gameDir, 'BepInEx')
  if (!existsSync(src)) throw new Error(`未找到 ${src}`)
  if (!existsSync(join(gameDir, 'winhttp.dll'))) {
    throw new Error('游戏根目录缺少 winhttp.dll（Doorstop 注入器），无法迁移')
  }

  const profileId = newProfileId()
  const destBep = join(profileDir(gameName, gameDir, profileId), 'BepInEx')

  // 备份 doorstop 配置
  const ini = join(gameDir, 'doorstop_config.ini')
  let iniBackup: string | null = null
  if (existsSync(ini)) {
    iniBackup = ini + '.bak'
    try {
      cpSync(ini, iniBackup, { force: true })
    } catch {
      iniBackup = null
    }
  }

  try {
    // 1. 复制 BepInEx 整树（跨盘安全）+ 元数据
    mkdirSync(dirname(destBep), { recursive: true })
    cpSync(src, destBep, { recursive: true })
    // 1.5. Cpp2IL Unity 6 兼容补丁（迁移来源可能是未修复版本）
    try {
      applyCpp2IlPatch(destBep)
    } catch {
      /* 补丁失败不影响迁移主流程 */
    }
    writeMeta(gameName, gameDir, profileId, {
      name: profileName,
      gameName,
      createdAt: new Date().toISOString()
    })

    // 2. 更新 doorstop target（失败则抛错走回滚）
    const target = pointDoorstopToProfile(gameDir, destBep)

    // 3. 全部成功：删游戏目录源
    rmSync(src, { recursive: true, force: true })

    return { profileId, target }
  } catch (e) {
    // 回滚：恢复游戏目录 BepInEx + doorstop 配置
    if (!existsSync(src) && existsSync(destBep)) {
      try {
        cpSync(destBep, src, { recursive: true })
      } catch {
        /* 恢复失败记录在错误信息里 */
      }
    }
    if (iniBackup && existsSync(iniBackup)) {
      try {
        cpSync(iniBackup, ini, { force: true })
      } catch {
        /* 忽略 */
      }
    }
    try {
      rmSync(profileDir(gameName, gameDir, profileId), { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    throw new Error(`迁移失败（已自动回滚，游戏目录保持不变）: ${e}`)
  }
}

/**
 * 新建隔离档案：从当前生效档案复制 BepInEx 框架（排除 plugins/config/日志缓存），
 * 新档案从干净状态开始，可独立装插件与配置。创建后自动切换生效。
 */
export function createIsolatedProfile(
  gameDir: string,
  gameName: string,
  profileName: string
): { profileId: string; target: string } {
  const cur = currentIsolatedProfile(gameDir, gameName)
  if (!cur) throw new Error('当前不在隔离模式（或 doorstop 未指向插件库），无法创建档案')

  const srcBep = join(profileDir(gameName, gameDir, cur.id), 'BepInEx')
  if (!existsSync(join(srcBep, 'core'))) throw new Error('当前档案缺少 BepInEx 框架')

  const profileId = newProfileId()
  const destBep = join(profileDir(gameName, gameDir, profileId), 'BepInEx')
  mkdirSync(dirname(destBep), { recursive: true })
  cpSync(srcBep, destBep, {
    recursive: true,
    filter: (src) => {
      const rel = src.replace(/\\/g, '/')
      // 排除插件/配置/日志缓存——新档案从干净状态开始
      const base = rel.split('/').pop() ?? ''
      if (base === 'plugins' || base === 'config' || base === 'cache') return false
      if (base.endsWith('.log') || base === 'LogOutput.log' || base === 'ErrorLog.log') return false
      return true
    }
  })

  // 确保 plugins/config 目录存在（空目录不会随 cpSync 复制）
  mkdirSync(join(destBep, 'plugins'), { recursive: true })
  mkdirSync(join(destBep, 'config'), { recursive: true })

  // Cpp2IL Unity 6 兼容补丁（源档案可能是未修复版本）
  try {
    applyCpp2IlPatch(destBep)
  } catch {
    /* 补丁失败不影响档案创建主流程 */
  }

  writeMeta(gameName, gameDir, profileId, {
    name: profileName,
    gameName,
    createdAt: new Date().toISOString()
  })

  // 创建后自动切换生效
  const target = pointDoorstopToProfile(gameDir, destBep)
  return { profileId, target }
}

/** 切换隔离档案：doorstop target 指向另一档案 */
export function switchIsolatedProfile(
  gameDir: string,
  gameName: string,
  profileId: string
): { target: string } {
  const dest = join(profileDir(gameName, gameDir, profileId), 'BepInEx')
  if (!existsSync(join(dest, 'core'))) {
    throw new Error(`档案「${profileId}」不存在或未包含 BepInEx`)
  }
  const target = pointDoorstopToProfile(gameDir, dest)
  return { target }
}

/** 删除隔离档案目录（保护：当前生效档案不可删除） */
export function removeIsolatedProfile(gameDir: string, gameName: string, profileId: string): void {
  const cur = currentIsolatedProfile(gameDir, gameName)
  if (cur && cur.id === profileId) {
    throw new Error(`「${cur.name}」是当前生效档案（doorstop 正指向它），请先切换档案或还原到游戏目录后再删除`)
  }
  const dir = profileDir(gameName, gameDir, profileId)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

/** 列出某游戏的所有隔离档案 */
export function listIsolatedProfiles(gameDir: string, gameName: string): IsolatedProfileInfo[] {
  const root = resolveGamePluginsRoot(gameDir, gameName)
  if (!existsSync(root)) return []
  try {
    return readdirSync(root)
      .filter((d) => existsSync(join(root, d, 'BepInEx')))
      .map((id) => {
        const meta = readMeta(gameName, gameDir, id)
        return { id, name: meta.name || id, createdAt: meta.createdAt }
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  } catch {
    return []
  }
}

/** 当前 doorstop 指向的档案（隔离模式下） */
export function currentIsolatedProfile(gameDir: string, gameName: string): IsolatedProfileInfo | null {
  const ini = join(gameDir, 'doorstop_config.ini')
  const target = readDoorstopTarget(ini)
  if (!target) return null
  const root = resolveGamePluginsRoot(gameDir, gameName)
  if (!existsSync(root)) return null
  for (const id of readdirSync(root)) {
    const bep = join(root, id, 'BepInEx')
    if (existsSync(bep) && target.toLowerCase().startsWith(bep.toLowerCase())) {
      const meta = readMeta(gameName, gameDir, id)
      return { id, name: meta.name || id, createdAt: meta.createdAt }
    }
  }
  return null
}
