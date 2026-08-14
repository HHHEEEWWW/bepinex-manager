/**
 * 引擎支持性检测快速检查
 * 用法：node scripts/check-engine.cjs（先 esbuild 打包）
 */
import { discoverGames } from '../src/main/core/games'

for (const g of discoverGames()) {
  console.log(
    (g.compatible ? 'OK ' : 'NO ') +
      g.name.padEnd(36) +
      (g.engine ?? '-') +
      (g.bepinex ? ' [BepInEx]' : '')
  )
}
