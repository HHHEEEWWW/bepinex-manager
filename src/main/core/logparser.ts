/**
 * BepInEx LogOutput.log 解析
 *
 * 兼容 BepInEx 5（Mono）与 6（IL2CPP）的日志格式：
 *   BepInEx 5: [Info   :PluginName] message
 *              [Error  :Unity Log] message
 *   BepInEx 6: [Info   :   BepInEx] message  （含或不含时间戳前缀）
 *
 * 支持增量读取（按字节偏移），主进程维护每个游戏的偏移缓存。
 */
import { existsSync, readFileSync, statSync } from 'fs'
import type { BepInExInfo, LogEntry, LogLevel, LogReadResult } from '@shared/types'

/** 日志读取结果（引用共享类型） */
export type { LogEntry, LogLevel, LogReadResult }

/** 级别正则（BepInEx 5/6 的级别名） */
const LEVEL_MAP: Record<string, LogLevel> = {
  info: 'info',
  message: 'info',
  notice: 'info',
  debug: 'debug',
  warning: 'warn',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal'
}

/** 解析一行日志，返回 null 表示非日志行 */
function parseLine(line: string, lineNo: number): LogEntry | null {
  // 格式：[Level  :Source] message   或  [HH:mm:ss Level:Source] message
  const m = line.match(/^\[(?:(?:\d{1,2}:){2}\d{1,2}\s+)?(\w+)\s*:([^\]]*)\]\s?(.*)$/)
  if (!m) return null
  const level = LEVEL_MAP[m[1].toLowerCase()] ?? 'info'
  const source = m[2].trim() || '未知'
  const message = m[3]
  return { level, source, message, isStack: false, line: lineNo }
}

/** 解析日志文本，返回条目列表 */
export function parseLog(text: string): LogEntry[] {
  const entries: LogEntry[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const entry = parseLine(line, i + 1)
    if (entry) {
      entries.push(entry)
    } else if (entries.length > 0) {
      // 非日志行：异常堆栈（at xxx）或续行，归入上一条
      const last = entries[entries.length - 1]
      if (/^\s*(at\s|--->|Exception|UnityException|System\.)/.test(line)) {
        last.message += '\n' + line
        last.isStack = true
      }
    }
  }
  return entries
}

const EMPTY_STATS: Array<{ source: string; count: number }> = []

/** 读取日志（增量：从 offset 字节开始读；offset=0 读全量） */
export function readLog(bepinex: BepInExInfo, offset = 0): LogReadResult {
  const path = bepinex.logFile
  if (!path || !existsSync(path)) {
    return { exists: false, path, entryCount: 0, entries: [], errorStats: EMPTY_STATS }
  }
  const size = statSync(path).size
  // 文件被截断/重写时从 0 读
  const from = offset > size ? 0 : offset
  const text = readFileSync(path, 'utf8').slice(from)
  const entries = parseLog(text)
  return {
    exists: true,
    path,
    entryCount: entries.length,
    entries,
    errorStats: buildErrorStats(entries)
  }
}

/** 错误统计：按来源统计 error/fatal 条目数 */
export function buildErrorStats(entries: LogEntry[]): Array<{ source: string; count: number }> {
  const bySource = new Map<string, number>()
  for (const e of entries) {
    if (e.level === 'error' || e.level === 'fatal') {
      bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1)
    }
  }
  return [...bySource.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
}
