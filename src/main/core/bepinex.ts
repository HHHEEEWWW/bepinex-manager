/**
 * BepInEx 安装检测
 * 支持 BepInEx 5.x（Mono 游戏）与 BepInEx 6.x（IL2CPP 游戏），
 * 以及"隔离模式"：BepInEx 整树在档案目录，游戏目录只有注入件
 * （winhttp.dll + doorstop_config.ini，target 指向档案内 preloader）。
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import type { BepInExInfo } from '@shared/types'

/** 检测一个游戏目录的 BepInEx 安装（常规或隔离模式） */
export function detectBepInEx(gameDir: string): BepInExInfo | null {
  // 1) 常规模式：gameDir/BepInEx 存在且完整（core 缺失视为残留/半成品，不误判）
  const bepinexDir = join(gameDir, 'BepInEx')
  if (existsSync(bepinexDir) && existsSync(join(bepinexDir, 'core'))) {
    return buildInfo(gameDir, bepinexDir, false)
  }

  // 2) 隔离模式：winhttp.dll + doorstop_config.ini 存在，target 指向档案目录
  if (existsSync(join(gameDir, 'winhttp.dll')) && existsSync(join(gameDir, 'doorstop_config.ini'))) {
    const target = readDoorstopTarget(join(gameDir, 'doorstop_config.ini'))
    if (target) {
      // target 形如 <档案>/BepInEx/core/BepInEx.Unity.IL2CPP.dll
      const coreDir = dirname(target)
      const rootDir = dirname(coreDir)
      if (
        existsSync(join(coreDir, 'BepInEx.dll')) ||
        existsSync(join(coreDir, 'BepInEx.Core.dll')) ||
        existsSync(join(rootDir, 'interop'))
      ) {
        return buildInfo(gameDir, rootDir, true)
      }
    }
  }
  return null
}

/** 构造 BepInExInfo（rootDir = BepInEx 数据根） */
function buildInfo(gameDir: string, rootDir: string, isIsolated: boolean): BepInExInfo {
  const coreDir = join(rootDir, 'core')
  const hasInterop = existsSync(join(rootDir, 'interop'))
  const hasCore5 = existsSync(join(coreDir, 'BepInEx.dll'))
  const hasCore6 = existsSync(join(coreDir, 'BepInEx.Core.dll'))
  const isMono = hasCore5 || (!hasInterop && !hasCore6)
  const logFile = join(rootDir, 'LogOutput.log')

  return {
    gameDir,
    majorVersion: isMono ? (5 as const) : (6 as const),
    isMono,
    rootDir,
    isIsolated,
    coreDir,
    pluginsDir: join(rootDir, 'plugins'),
    configDir: join(rootDir, 'config'),
    logFile: existsSync(logFile) ? logFile : null,
    version: readVersionFromLog(logFile)
  }
}

/** 从 doorstop_config.ini 读取 target（preloader 路径），兼容 v3/v4 */
export function readDoorstopTarget(iniPath: string): string | null {
  try {
    const text = readFileSync(iniPath, 'utf8')
    // v3: [UnityDoorstop] targetAssembly=...  v4: [General] target_assembly=...
    const m = text.match(/^\s*target(?:_assembly|Assembly)\s*=\s*([^\r\n]+)/im)
    if (!m) return null
    const raw = m[1].trim()
    if (raw === '') return null
    // 相对路径（如 BepInEx\core\...）基于 ini 所在目录解析
    return /^[a-zA-Z]:[\\/]/.test(raw) ? raw : join(dirname(iniPath), raw.replace(/\//g, '\\'))
  } catch {
    return null
  }
}

/** 从 LogOutput.log 提取 BepInEx 版本字符串 */
function readVersionFromLog(logFile: string): string | null {
  if (!existsSync(logFile)) return null
  try {
    const head = readFileSync(logFile, 'utf8').slice(0, 8192)
    // BepInEx 5 日志首行形如：BepInEx 5.4.23.2 - (2023-...)
    // BepInEx 6 日志形如：[Info   :Unity Log] BepInEx 6.0.0 ...
    const m = head.match(/BepInEx\s+(\d+\.\d+(?:\.\d+){0,2})/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** 列出 BepInEx 目录下的子目录（用于调试/展示） */
export function listBepInExDirs(gameDir: string): string[] {
  const dir = join(gameDir, 'BepInEx')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}
