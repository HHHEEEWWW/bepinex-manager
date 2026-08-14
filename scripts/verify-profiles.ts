/**
 * Profile 系统真实环境验证（不依赖 Electron）
 * 用法：node scripts/verify-profiles.cjs（先 esbuild 打包）
 *
 * 安全闭环设计：最终插件状态 = 初始状态。
 *   1. 快照当前状态为档案
 *   2. 应用档案（应无变更，验证无副作用）
 *   3. 禁用第一个插件 → 应用档案（应恢复启用）
 *   4. 确认插件恢复，清理档案与临时数据
 */
import { discoverGames } from '../src/main/core/games'
import { detectBepInEx } from '../src/main/core/bepinex'
import { scanPlugins, setPluginEnabled } from '../src/main/core/plugins'
import { createProfile, applyProfile, deleteProfile, listProfiles, profilesFilePath } from '../src/main/core/profiles'
import { filterRelease, isMatchingAsset } from '../src/main/core/installer'
import { rmSync, existsSync } from 'fs'

const TARGET_GAME = process.env.BEPINEX_MANAGER_TEST_GAME ?? 'DreamEcho'

async function main(): Promise<void> {
  const games = discoverGames()
  const target = games.find((g) => g.name.includes(TARGET_GAME) || g.gameDir.includes(TARGET_GAME))
  if (!target || !target.bepinex) {
    console.error(`未找到测试游戏 ${TARGET_GAME}（或未安装 BepInEx）`)
    process.exit(1)
  }
  const bepinex = target.bepinex

  console.log(`=== Profile 验证：${target.name} ===`)
  const before = scanPlugins(bepinex)
  console.log(`初始插件: ${before.plugins.length} 个`)

  // 1. 创建档案
  const profile = createProfile(bepinex.gameDir, 'verify-test', Object.fromEntries(before.plugins.map((p) => [p.id, p.enabled])))
  console.log(`[1] 已创建档案: ${profile.id} (${Object.keys(profile.pluginStates).length} 项)`)
  if (!existsSync(profilesFilePath())) throw new Error('profiles.json 未生成')

  // 2. 应用（无差异）
  const r2 = applyProfile(bepinex, profile.id)
  console.log(`[2] 应用档案（期望 0 变更）: applied=${r2.applied} rolledBack=${r2.rolledBack}`)
  if (r2.applied !== 0) throw new Error('无差异应用不应产生变更')

  // 3. 禁用第一个插件 → 应用档案恢复
  const first = before.plugins.find((p) => p.enabled)
  if (!first) {
    console.log('没有启用的插件可测，跳过变更闭环')
  } else {
    setPluginEnabled(bepinex, first.id, false)
    const mid = scanPlugins(bepinex)
    const midState = mid.plugins.find((p) => p.id === first.id)
    console.log(`[3] 已禁用 ${first.id}（当前 enabled=${midState?.enabled}）`)
    if (midState?.enabled !== false) throw new Error('禁用操作未生效')

    const r3 = applyProfile(bepinex, profile.id)
    console.log(`[3b] 应用档案（期望 1 项变更）: applied=${r3.applied} rolledBack=${r3.rolledBack} changes=[${r3.changes.join(', ')}]`)
    if (r3.applied !== 1) throw new Error('应用档案应恢复 1 个插件')

    const after = scanPlugins(bepinex)
    const afterState = after.plugins.find((p) => p.id === first.id)
    console.log(`[4] 恢复检查: ${first.id} enabled=${afterState?.enabled}`)
    if (afterState?.enabled !== true) throw new Error('插件未恢复到启用状态')
  }

  // 5. 清理
  deleteProfile(bepinex.gameDir, profile.id)
  console.log(`[5] 已删除档案，剩余: ${listProfiles(bepinex.gameDir).length}`)

  console.log('\n=== BepInEx 资产过滤验证（离线 fixture） ===')
  const fixture = {
    tag_name: 'v6.0.0-pre.2',
    prerelease: true,
    published_at: '2025-01-01T00:00:00Z',
    assets: [
      { name: 'BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip', browser_download_url: 'u1', size: 1 },
      { name: 'BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip', browser_download_url: 'u2', size: 2 },
      { name: 'BepInEx-Unity.IL2CPP-linux-x64-6.0.0-pre.2.zip', browser_download_url: 'u3', size: 3 },
      { name: 'BepInEx_win_x64_5.4.23.5.zip', browser_download_url: 'u4', size: 4 },
      { name: 'BepInEx_win_x86_5.4.23.5.zip', browser_download_url: 'u5', size: 5 }
    ]
  }
  const il2cpp = filterRelease(fixture, 'il2cpp')
  const mono = filterRelease(fixture, 'mono')
  console.log(`il2cpp 资产: [${il2cpp.assets.map((a) => a.name).join(', ')}]`)
  console.log(`mono 资产: [${mono.assets.map((a) => a.name).join(', ')}]`)
  if (il2cpp.assets.length !== 1 || !il2cpp.assets[0].name.includes('IL2CPP-win-x64')) {
    throw new Error('il2cpp 过滤结果错误')
  }
  if (mono.assets.length !== 2) {
    throw new Error('mono 过滤结果错误（应含 Unity.Mono-win-x64 与 BepInEx_win_x64_5）')
  }
  console.log('资产过滤规则 ✅')

  console.log('\n✅ Profile 与 Release 验证全部通过')
}

main().catch((e) => {
  console.error('验证失败:', e)
  process.exit(1)
})
