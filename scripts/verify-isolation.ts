/**
 * Profile 隔离模式 v2 验证（临时目录模拟游戏，不碰真实游戏）
 * 用法：node scripts/verify-isolation.cjs（先 esbuild 打包）
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, cpSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectBepInEx } from '../src/main/core/bepinex'
import { scanPlugins } from '../src/main/core/plugins'
import {
  migrateToIsolated,
  switchIsolatedProfile,
  restoreFromIsolated,
  listIsolatedProfiles,
  currentIsolatedProfile,
  profileDir
} from '../src/main/core/isolation'

const root = join(tmpdir(), 'bepinex-isolation-test-' + Date.now())
const gameDir = join(root, 'game')
const dataDir = join(root, 'data')
process.env.BEPINEX_MANAGER_DATA_DIR = dataDir

function makeGame(): void {
  // 模拟 BepInEx 6 IL2CPP 游戏
  mkdirSync(join(gameDir, 'BepInEx', 'core'), { recursive: true })
  mkdirSync(join(gameDir, 'BepInEx', 'plugins'), { recursive: true })
  mkdirSync(join(gameDir, 'BepInEx', 'config'), { recursive: true })
  writeFileSync(join(gameDir, 'winhttp.dll'), 'fake-doorstop')
  writeFileSync(join(gameDir, '.doorstop_version'), '4.0.0')
  writeFileSync(join(gameDir, 'BepInEx', 'core', 'BepInEx.Core.dll'), 'x')
  writeFileSync(join(gameDir, 'BepInEx', 'core', 'BepInEx.Unity.IL2CPP.dll'), 'x')
  writeFileSync(join(gameDir, 'BepInEx', 'plugins', 'FakeMod.dll'), 'not-real-dll')
  writeFileSync(join(gameDir, 'BepInEx', 'config', 'com.fake.mod.cfg'), '[General]\nX = 1\n')
  writeFileSync(
    join(gameDir, 'doorstop_config.ini'),
    '[General]\nenabled=true\ntarget_assembly=BepInEx\\core\\BepInEx.Unity.IL2CPP.dll\n'
  )
}

try {
  makeGame()
  console.log('=== 1. 常规检测 ===')
  const info0 = detectBepInEx(gameDir)
  if (!info0 || info0.isIsolated || info0.majorVersion !== 6) {
    throw new Error('常规模式检测失败: ' + JSON.stringify(info0))
  }
  console.log('常规检测 ✅（BepInEx 6, plugins=' + info0.pluginsDir + '）')

  console.log('\n=== 2. 迁移到隔离模式 ===')
  const m = migrateToIsolated(gameDir, '单机存档')
  console.log('target -> ' + m.target)
  if (existsSync(join(gameDir, 'BepInEx'))) throw new Error('迁移后游戏目录 BepInEx 应被移除')
  if (!existsSync(join(dataDir, 'profiles'))) throw new Error('档案目录未创建')
  const ini = readFileSync(join(gameDir, 'doorstop_config.ini'), 'utf8')
  if (!ini.includes(m.target)) throw new Error('doorstop target 未指向档案 preloader')
  console.log('迁移 ✅（BepInEx 已移入档案，doorstop 已指向档案）')

  console.log('\n=== 3. 隔离模式检测 + 插件扫描 ===')
  const info1 = detectBepInEx(gameDir)
  if (!info1 || !info1.isIsolated) throw new Error('隔离模式检测失败')
  const scan = scanPlugins(info1)
  if (scan.plugins.length !== 1 || scan.plugins[0].fileName !== 'FakeMod.dll') {
    throw new Error('隔离模式插件扫描失败: ' + scan.plugins.length)
  }
  console.log('隔离检测/扫描 ✅（plugins=' + info1.pluginsDir + ', 插件=' + scan.plugins[0].fileName + '）')

  console.log('\n=== 4. 第二个档案 + 切换 ===')
  // 用 profileDir 建第二个档案
  mkdirSync(join(profileDir(gameDir, '联机存档'), 'BepInEx', 'core'), { recursive: true })
  writeFileSync(
    join(profileDir(gameDir, '联机存档'), 'BepInEx', 'core', 'BepInEx.Unity.IL2CPP.dll'),
    'x'
  )
  const s = switchIsolatedProfile(gameDir, '联机存档')
  if (!s.target.includes('联机存档')) throw new Error('切换失败: ' + s.target)
  const cur = currentIsolatedProfile(gameDir)
  if (cur !== '联机存档') throw new Error('当前档案识别失败: ' + cur)
  const list = listIsolatedProfiles(gameDir)
  if (!list.includes('单机存档') || !list.includes('联机存档')) throw new Error('档案列表错误: ' + list)
  console.log('切换/识别 ✅（当前=' + cur + ', 档案=' + list.join(', ') + '）')

  console.log('\n=== 5. 还原到游戏目录 ===')
  restoreFromIsolated(gameDir, '单机存档')
  if (!existsSync(join(gameDir, 'BepInEx', 'plugins'))) throw new Error('还原后 BepInEx 缺失')
  const ini2 = readFileSync(join(gameDir, 'doorstop_config.ini'), 'utf8')
  if (!/target_assembly\s*=\s*BepInEx\\core\\/.test(ini2)) {
    throw new Error('还原后 target 应为游戏内相对路径: ' + ini2)
  }
  const info2 = detectBepInEx(gameDir)
  if (!info2 || info2.isIsolated) throw new Error('还原后应恢复常规模式')
  console.log('还原 ✅（BepInEx 回到游戏目录，target=' + /target_assembly\s*=\s*([^\r\n]+)/.exec(ini2)?.[1] + '）')

  console.log('\n✅ 隔离模式全部验证通过')
} finally {
  rmSync(root, { recursive: true, force: true })
}
