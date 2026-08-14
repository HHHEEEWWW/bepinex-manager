/**
 * 日志解析验证：fixture 格式测试 + 真实游戏日志
 * 用法：node scripts/verify-log.cjs（先 esbuild 打包）
 */
import { parseLog, buildErrorStats, readLog } from '../src/main/core/logparser'
import { discoverGames } from '../src/main/core/games'

// ---- fixture 测试 ----
const fixture = [
  '[Info   :   BepInEx] BepInEx 6.0.0 - (2025-01-01)',
  '[Info   :Unity Log] Loading player data',
  '[Warn   :MyPlugin] Config value out of range, using default',
  '[Error  :MyPlugin] Failed to patch method Player.TakeDamage',
  '  at MyPlugin.Patches.Patch_TakeDamage.Postfix ()',
  '  --- End of stack trace ---',
  '[Fatal  :   BepInEx] Chainloader aborted',
  '[Info   :DreamEchoMod] Plugin loaded! Guid=com.dreamecho.mod',
  'some random text without bracket',
  '[Debug  :OtherMod] verbose detail'
].join('\n')

const entries = parseLog(fixture)
console.log(`fixture: 解析 ${entries.length} 条（9 行，2 个堆栈行合并进错误条目）`)
if (entries.length !== 7) throw new Error(`期望 7 条（堆栈合并），实际 ${entries.length}`)

const first = entries[0]
if (first.level !== 'info' || first.source !== 'BepInEx') throw new Error('BepInEx 6 行解析错误: ' + JSON.stringify(first))
const warn = entries[2]
if (warn.level !== 'warn' || warn.source !== 'MyPlugin') throw new Error('警告行解析错误')
const err = entries[3]
if (err.level !== 'error' || !err.message.includes('Failed to patch') || !err.isStack) throw new Error('错误行/堆栈合并解析错误')
const fatal = entries[4]
if (fatal.level !== 'fatal') throw new Error('Fatal 行解析错误')

const stats = buildErrorStats(entries)
console.log(`fixture: 错误统计 -> ${JSON.stringify(stats)}`)
if (stats[0].source !== 'MyPlugin' || stats[0].count !== 1) throw new Error('错误统计错误')
console.log('fixture 全部通过 ✅')

// ---- 真实日志 ----
const game = discoverGames().find((g) => g.bepinex?.logFile)
if (!game?.bepinex) {
  console.log('没有带日志的 BepInEx 游戏，跳过真实日志验证')
} else {
  const result = readLog(game.bepinex, 0)
  console.log(`\n真实日志: ${game.name} -> ${result.path}`)
  console.log(`  条目数: ${result.entryCount}（info=${result.entries.filter((e) => e.level === 'info').length}, warn=${result.entries.filter((e) => e.level === 'warn').length}, error=${result.entries.filter((e) => e.level === 'error' || e.level === 'fatal').length}）`)
  const errs = result.entries.filter((e) => e.level === 'error' || e.level === 'fatal')
  for (const e of errs.slice(0, 5)) {
    console.log(`  [${e.level}] ${e.source}: ${e.message.slice(0, 100)}`)
  }
  if (result.errorStats.length) {
    console.log(`  崩溃定位: ${result.errorStats.slice(0, 3).map((s) => `${s.source}×${s.count}`).join(', ')}`)
  }
  console.log('真实日志解析 ✅')
}

console.log('\n✅ 日志解析验证全部通过')
