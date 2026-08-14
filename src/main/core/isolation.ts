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
 * 档案目录结构：
 *   <dataRoot>/profiles/<gameKey>/<profileName>/BepInEx/...
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

/** preloader 候选文件名（BepInEx 5/6 各变体） */
const PRELOADER_NAMES = [
  'BepInEx.Unity.Mono.Preloader.dll',
  'BepInEx.Unity.IL2CPP.dll',
  'BepInEx.Preloader.dll',
  'BepInEx.IL2CPP.dll',
  'BepInEx.NET.CoreCLR.dll'
]

/** 游戏目录哈希键（用于文件系统目录名，过滤非法字符） */
function gameKey(gameDir: string): string {
  return (
    gameDir
      .toLowerCase()
      .replace(/[\\/]+$/, '')
      .replace(/[^a-z0-9]/g, '_') + '_' + hashId(gameDir)
  )
}

/** 简单哈希（保证键唯一） */
function hashId(path: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** 某游戏的档案根目录 */
export function profilesRootDir(gameDir: string): string {
  return join(dataRootDir(), 'profiles', gameKey(gameDir))
}

/** 某档案的目录（不含 BepInEx 子目录） */
export function profileDir(gameDir: string, profileName: string): string {
  return join(profilesRootDir(gameDir), profileName)
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

/** 更新游戏目录 doorstop 指向档案 preloader（迁移/切换共用） */
function pointDoorstopToProfile(gameDir: string, profileBepInExDir: string): string {
  const coreDir = join(profileBepInExDir, 'core')
  const preloader = findPreloader(coreDir)
  if (!preloader) throw new Error(`档案目录缺少 preloader dll: ${coreDir}`)
  const target = join(coreDir, preloader)
  const isV4 = doorstopIsV4(gameDir)
  writeDoorstopTarget(join(gameDir, 'doorstop_config.ini'), target, isV4)
  return target
}

/**
 * 迁移现有安装到隔离模式：
 *   把 gameDir/BepInEx 复制到档案目录，游戏根只留注入件，
 *   doorstop target 指向档案 preloader。
 * 迁移前自动备份 doorstop_config.ini（.bak），失败可还原。
 */
export function migrateToIsolated(gameDir: string, profileName: string): { target: string; profileBepInExDir: string } {
  const src = join(gameDir, 'BepInEx')
  if (!existsSync(src)) throw new Error(`未找到 ${src}`)
  if (!existsSync(join(gameDir, 'winhttp.dll'))) {
    throw new Error('游戏根目录缺少 winhttp.dll（Doorstop 注入器），无法迁移')
  }

  const dest = join(profileDir(gameDir, profileName), 'BepInEx')
  if (existsSync(dest)) {
    throw new Error(`档案「${profileName}」已存在，请换一个名称`)
  }

  // 备份 doorstop 配置
  const ini = join(gameDir, 'doorstop_config.ini')
  if (existsSync(ini)) {
    try {
      cpSync(ini, ini + '.bak', { force: true })
    } catch {
      /* 备份失败继续（ini 会被重写） */
    }
  }

  // 复制 BepInEx 整树（跨盘安全），成功后删源
  try {
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(src, dest, { recursive: true })
    rmSync(src, { recursive: true, force: true })
  } catch (e) {
    // 失败回滚：删掉复制的一半
    try {
      rmSync(dirname(dest), { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    throw new Error(`迁移失败（已回滚）: ${e}`)
  }

  const target = pointDoorstopToProfile(gameDir, dest)
  return { target, profileBepInExDir: dest }
}

/** 切换隔离档案：doorstop target 指向另一档案 */
export function switchIsolatedProfile(gameDir: string, profileName: string): { target: string } {
  const dest = join(profileDir(gameDir, profileName), 'BepInEx')
  if (!existsSync(join(dest, 'core'))) {
    throw new Error(`档案「${profileName}」不存在或未包含 BepInEx`)
  }
  const target = pointDoorstopToProfile(gameDir, dest)
  return { target }
}

/** 从隔离模式还原：把档案 BepInEx 复制回游戏目录，恢复原生 doorstop 配置 */
export function restoreFromIsolated(gameDir: string, profileName: string): void {
  const src = join(profileDir(gameDir, profileName), 'BepInEx')
  if (!existsSync(src)) throw new Error(`档案「${profileName}」不存在`)
  const dest = join(gameDir, 'BepInEx')
  if (existsSync(dest)) throw new Error('游戏目录已存在 BepInEx，拒绝覆盖')

  cpSync(src, dest, { recursive: true })

  // 恢复 doorstop target 为游戏目录内的 preloader（相对路径，兼容 Steam 启动）
  const preloader = findPreloader(join(dest, 'core'))
  const isV4 = doorstopIsV4(gameDir)
  if (preloader) {
    writeDoorstopTarget(join(gameDir, 'doorstop_config.ini'), `BepInEx\\core\\${preloader}`, isV4)
  }
}

/** 删除隔离档案目录 */
export function removeIsolatedProfile(gameDir: string, profileName: string): void {
  const dir = profileDir(gameDir, profileName)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

/** 列出某游戏的所有隔离档案目录名 */
export function listIsolatedProfiles(gameDir: string): string[] {
  const root = profilesRootDir(gameDir)
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(d.path ?? root, d.name, 'BepInEx')))
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** 当前 doorstop 指向的档案名（隔离模式下） */
export function currentIsolatedProfile(gameDir: string): string | null {
  const ini = join(gameDir, 'doorstop_config.ini')
  const target = readDoorstopTarget(ini)
  if (!target) return null
  const root = profilesRootDir(gameDir)
  if (!existsSync(root)) return null
  for (const name of readdirSync(root)) {
    const bep = join(root, name, 'BepInEx')
    if (existsSync(bep) && target.toLowerCase().startsWith(bep.toLowerCase())) {
      return name
    }
  }
  return null
}
