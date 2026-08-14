/**
 * 核心逻辑独立验证脚本（不依赖 Electron）
 * 用法：node scripts/verify-core.cjs（先 esbuild 打包）
 *
 * 验证内容：
 *   1. Steam 库扫描 → 发现游戏
 *   2. BepInEx 检测
 *   3. 插件扫描 + C# 元数据解析
 */
import { discoverGames } from '../src/main/core/games'
import { scanPlugins } from '../src/main/core/plugins'

async function main(): Promise<void> {
  console.log('=== 1. 游戏发现 ===')
  const games = discoverGames()
  console.log(`发现 ${games.length} 个游戏（含无 BepInEx 的）：`)
  for (const g of games) {
    const b = g.bepinex ? `BepInEx ${g.bepinex.majorVersion} v${g.bepinex.version ?? '?'} ${g.bepinex.isMono ? 'Mono' : 'IL2CPP'}` : '无 BepInEx'
    console.log(`  [${g.source}] ${g.name} (${g.gameDir}) -> ${b}`)
  }

  const withBep = games.filter((g) => g.bepinex)
  if (withBep.length === 0) {
    console.log('没有找到安装 BepInEx 的游戏，跳过插件扫描验证')
    return
  }

  console.log('\n=== 2. 插件扫描（第一个带 BepInEx 的游戏）===')
  const target = withBep[0]
  console.log(`游戏: ${target.name} (${target.gameDir})`)
  const result = scanPlugins(target.bepinex!)
  console.log(`插件总数: ${result.plugins.length}（启用 ${result.plugins.filter((p) => p.enabled).length}）`)

  let ok = 0
  let fail = 0
  for (const p of result.plugins) {
    if (p.meta) {
      ok++
      console.log(`  [${p.enabled ? 'ON ' : 'OFF'}] ${p.meta.name} v${p.meta.version} (${p.meta.guid})${p.meta.dependencies.length ? ' deps=[' + p.meta.dependencies.join(',') + ']' : ''}${p.configFile ? ' cfg=✓' : ''}`)
    } else {
      fail++
      console.log(`  [${p.enabled ? 'ON ' : 'OFF'}] ${p.fileName} 元数据失败: ${p.metaError ?? '未知'}`)
    }
  }
  console.log(`\n解析成功 ${ok}，失败 ${fail}`)
}

main().catch((e) => {
  console.error('验证失败:', e)
  process.exit(1)
})
