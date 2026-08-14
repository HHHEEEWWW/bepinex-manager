/**
 * 游戏发现：Steam 库扫描 + 手动添加
 *
 * Steam 库扫描流程：
 *   1. 注册表 HKCU\Software\Valve\Steam 读取 SteamPath
 *   2. 解析 steamapps/libraryfolders.vdf 得到所有库路径
 *   3. 解析每个库的 appmanifest_*.acf 得到 {appid, name, installdir}
 *   4. 检查 common/<installdir>/BepInEx 是否存在
 */
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { GameEntry } from '@shared/types'
import { detectBepInEx } from './bepinex'

interface AcfEntry {
  appid: number
  name: string
  installdir: string
}

/** 发现所有游戏（含 BepInEx 状态） */
export function discoverGames(): GameEntry[] {
  const games: GameEntry[] = []

  // Steam 库
  const steamPath = findSteamPath()
  if (steamPath) {
    const libs = readLibraryFolders(steamPath)
    const seen = new Set<string>()
    for (const lib of libs) {
      const commonDir = join(lib, 'steamapps', 'common')
      if (!existsSync(commonDir)) continue
      for (const entry of readAcfEntries(lib)) {
        const gameDir = join(commonDir, entry.installdir)
        if (!existsSync(gameDir)) continue
        const key = gameDir.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        games.push({
          id: hashId(gameDir),
          name: entry.name,
          gameDir,
          source: 'steam',
          steamAppId: entry.appid,
          bepinex: detectBepInEx(gameDir)
        })
      }
    }
  }
  return games
}

/** 手动添加一个游戏目录 */
export function addManualGame(gameDir: string): GameEntry {
  const name = gameDir.split(/[\\/]/).filter(Boolean).pop() ?? gameDir
  return {
    id: hashId(gameDir),
    name,
    gameDir,
    source: 'manual',
    bepinex: detectBepInEx(gameDir)
  }
}

/** 读取 Steam 安装路径（注册表） */
function findSteamPath(): string | null {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {
      encoding: 'utf8'
    })
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i)
    if (m) return m[1].trim().replace(/\\+$/, '')
  } catch {
    /* 无 Steam 或注册表不可用 */
  }
  return null
}

/**
 * 解析 libraryfolders.vdf，返回所有库路径
 * VDF 是 Valve 的 KV 文本格式，这里写一个最小解析器
 */
function readLibraryFolders(steamPath: string): string[] {
  const vdfPath = join(steamPath, 'steamapps', 'libraryfolders.vdf')
  if (!existsSync(vdfPath)) return [steamPath]
  try {
    const text = readFileSync(vdfPath, 'utf8')
    const paths: string[] = []
    const re = /"path"\s*"([^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const p = m[1].replace(/\\\\/g, '\\')
      if (!paths.includes(p)) paths.push(p)
    }
    return paths.length > 0 ? paths : [steamPath]
  } catch {
    return [steamPath]
  }
}

/** 解析一个库下的所有 appmanifest_*.acf */
function readAcfEntries(libPath: string): AcfEntry[] {
  const appsDir = join(libPath, 'steamapps')
  if (!existsSync(appsDir)) return []
  try {
    const entries: AcfEntry[] = []
    for (const f of readdirSync(appsDir)) {
      const m = f.match(/^appmanifest_(\d+)\.acf$/)
      if (!m) continue
      const text = readFileSync(join(appsDir, f), 'utf8')
      const name = text.match(/"name"\s*"([^"]+)"/)?.[1]
      const installdir = text.match(/"installdir"\s*"([^"]+)"/)?.[1]
      if (name && installdir) {
        entries.push({ appid: Number(m[1]), name, installdir })
      }
    }
    return entries
  } catch {
    return []
  }
}

/** 目录路径 → 稳定 id（简单哈希） */
function hashId(path: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'g' + (h >>> 0).toString(16)
}
