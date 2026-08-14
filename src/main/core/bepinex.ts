/**
 * BepInEx 安装检测
 * 支持 BepInEx 5.x（Mono 游戏）与 BepInEx 6.x（IL2CPP 游戏）
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { BepInExInfo } from '@shared/types'

/** 检测一个游戏目录是否安装了 BepInEx，返回检测信息 */
export function detectBepInEx(gameDir: string): BepInExInfo | null {
  const bepinexDir = join(gameDir, 'BepInEx')
  if (!existsSync(bepinexDir)) return null

  const coreDir = join(bepinexDir, 'core')
  const pluginsDir = join(bepinexDir, 'plugins')
  const configDir = join(bepinexDir, 'config')
  const logFile = join(bepinexDir, 'LogOutput.log')

  // 6.x：启动时生成 interop 目录（Il2CppInterop 互操作程序集）
  const hasInterop = existsSync(join(bepinexDir, 'interop'))
  // 5.x：core/BepInEx.dll
  const hasCore5 = existsSync(join(coreDir, 'BepInEx.dll'))
  // 6.x：core/BepInEx.Core.dll
  const hasCore6 = existsSync(join(coreDir, 'BepInEx.Core.dll'))

  if (!hasCore5 && !hasCore6 && !hasInterop) {
    // 有 BepInEx 目录但核心缺失 → 视为未完整安装
    return null
  }

  const isMono = hasCore5 || (!hasInterop && !hasCore6)
  const majorVersion = hasInterop || hasCore6 ? 6 : 5

  return {
    gameDir,
    majorVersion: isMono ? majorVersion : (6 as const),
    isMono,
    coreDir,
    pluginsDir,
    configDir,
    logFile: existsSync(logFile) ? logFile : null,
    version: readVersionFromLog(logFile)
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
