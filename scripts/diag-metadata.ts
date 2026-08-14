/**
 * 元数据解析诊断：扫描所有带 BepInEx 的游戏，打印每个插件的解析结果与错误
 * 用法：node scripts/diag-metadata.cjs（先 esbuild 打包）
 */
import { discoverGames } from '../src/main/core/games'
import { scanPlugins } from '../src/main/core/plugins'

for (const g of discoverGames().filter((x) => x.bepinex)) {
  const r = scanPlugins(g.bepinex!)
  console.log(`== ${g.name} (${g.gameDir}) plugins=${r.plugins.length}`)
  for (const p of r.plugins) {
    console.log(`   [${p.enabled ? 'ON' : 'OFF'}] ${p.fileName}`)
    console.log(`       meta=${p.meta ? JSON.stringify(p.meta) : 'null'}`)
    if (p.metaError) console.log(`       error=${p.metaError}`)
  }
}
console.log('diag done')
