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
import { existsSync, readdirSync, readFileSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import type { GameEntry } from '@shared/types'
import { detectBepInEx } from './bepinex'

interface AcfEntry {
  appid: number
  name: string
  installdir: string
}

/** 发现所有游戏（含 BepInEx 状态与引擎支持性） */
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
        const bepinex = detectBepInEx(gameDir)
        games.push({
          id: hashId(gameDir),
          name: entry.name,
          gameDir,
          source: 'steam',
          steamAppId: entry.appid,
          bepinex,
          compatible: bepinex !== null || isBepInExCompatible(gameDir),
          engine: bepinex ? (bepinex.isMono ? 'Unity (Mono)' : 'Unity (IL2CPP)') : detectEngine(gameDir)
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
    bepinex: detectBepInEx(gameDir),
    compatible: true, // 用户手动指定的目录始终显示
    engine: null
  }
}

/**
 * 引擎支持性检测：判断游戏是否可能支持 BepInEx。
 * 判定顺序：Doorstop 注入件 → Unity IL2CPP → Unity Mono → .NET 可执行程序集
 */
export function detectEngine(gameDir: string): string | null {
  // Doorstop 已注入
  if (existsSync(join(gameDir, 'winhttp.dll')) && existsSync(join(gameDir, 'doorstop_config.ini'))) {
    return 'Doorstop 已注入'
  }
  // Unity IL2CPP：GameAssembly.dll + global-metadata.dat
  if (existsSync(join(gameDir, 'GameAssembly.dll')) && existsSync(join(gameDir, 'global-metadata.dat'))) {
    return 'Unity (IL2CPP)'
  }
  // Unity Mono：<X>_Data/Managed/Assembly-CSharp.dll 或 UnityPlayer.dll
  if (existsSync(join(gameDir, 'UnityPlayer.dll'))) return 'Unity (Mono)'
  try {
    const dataDirs = readdirSync(gameDir).filter((d) => d.endsWith('_Data'))
    for (const d of dataDirs) {
      if (existsSync(join(gameDir, d, 'Managed', 'Assembly-CSharp.dll'))) return 'Unity (Mono)'
    }
  } catch {
    /* 目录不可读则跳过 */
  }
  // .NET 可执行程序集（XNA/MonoGame 或任何托管 exe）
  try {
    for (const f of readdirSync(gameDir)) {
      if (f.toLowerCase().endsWith('.exe')) {
        if (isDotNetAssembly(join(gameDir, f))) return '.NET 程序'
      }
    }
  } catch {
    /* 忽略 */
  }
  return null
}

/** 是否支持 BepInEx（引擎检测到 .NET 相关特征） */
export function isBepInExCompatible(gameDir: string): boolean {
  return detectEngine(gameDir) !== null
}

/** PE 检查：exe 是否为 .NET 托管程序集（COM Descriptor 目录非零） */
function isDotNetAssembly(exePath: string): boolean {
  try {
    const fd = openSync(exePath, 'r')
    const buf = Buffer.alloc(8192)
    const read = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    if (read < 0x40) return false
    // DOS 头 MZ
    if (buf.readUInt16LE(0) !== 0x5a4d) return false
    const peOff = buf.readUInt32LE(0x3c)
    if (peOff + 6 > read) return false
    // PE 签名
    if (buf.readUInt32LE(peOff) !== 0x00004550) return false
    const magic = buf.readUInt16LE(peOff + 24)
    // Optional header 内 DataDirectory 起点：PE32 = 96，PE32+ = 112
    const ddStart = peOff + 24 + (magic === 0x20b ? 112 : 96)
    // DataDirectory[14] = COM Descriptor（.NET 标志）
    const comRva = buf.readUInt32LE(ddStart + 14 * 8)
    return comRva !== 0
  } catch {
    return false
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
