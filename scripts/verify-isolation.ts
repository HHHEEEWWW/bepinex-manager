/**
 * 插件库（隔离模式 v2）验证：临时目录模拟游戏，不碰真实游戏
 * 用法：node scripts/verify-isolation.cjs（先 esbuild 打包）
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, cpSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectBepInEx } from '../src/main/core/bepinex'
import { scanPlugins } from '../src/main/core/plugins'
import {
  migrateToIsolated,
  createIsolatedProfile,
  switchIsolatedProfile,
  removeIsolatedProfile,
  listIsolatedProfiles,
  currentIsolatedProfile,
  profileDir,
  gamePluginsRootDir,
  pluginsRootDir
} from '../src/main/core/isolation'

const root = join(tmpdir(), 'bepinex-pluginlib-test-' + Date.now())
const gameDir = join(root, 'game')
const dataDir = join(root, 'data')
const GAME_NAME = 'Test Game 测试'
process.env.BEPINEX_MANAGER_DATA_DIR = dataDir

function makeGame(): void {
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
  if (!info0 || info0.isIsolated || info0.majorVersion !== 6) throw new Error('常规检测失败')
  console.log('常规检测 ✅')

  console.log('\n=== 2. 迁移到插件库（中文游戏名/档案名）===')
  const m = migrateToIsolated(gameDir, GAME_NAME, '单机档')
  console.log('profileId=' + m.profileId + ' target -> ' + m.target)
  // 目录结构断言：<dataRoot>/plugins/<slug>-<hash>/<profileId>/BepInEx，全 ASCII
  const libRoot = pluginsRootDir()
  if (!libRoot.includes(join(dataDir, 'plugin-library'))) throw new Error('插件库根目录错误: ' + libRoot)
  const gameRoot = gamePluginsRootDir(GAME_NAME, gameDir)
  if (!/^[\x00-\x7f]+$/.test(gameRoot)) throw new Error('插件库游戏目录含非 ASCII: ' + gameRoot)
  if (!/test-game-\w{4}$/.test(gameRoot.split('\\').pop() ?? '')) {
    throw new Error('游戏 slug 不符合预期: ' + gameRoot.split('\\').pop())
  }
  const pPath = profileDir(GAME_NAME, gameDir, m.profileId)
  if (!/^[\x00-\x7f]+$/.test(pPath)) throw new Error('档案路径含非 ASCII: ' + pPath)
  if (existsSync(join(gameDir, 'BepInEx'))) throw new Error('迁移后游戏目录 BepInEx 应移除')
  const ini = readFileSync(join(gameDir, 'doorstop_config.ini'), 'utf8')
  if (!ini.includes(m.target)) throw new Error('doorstop target 未指向插件库')
  console.log('迁移 ✅（插件库目录 = ' + gameRoot.split('\\').pop() + '\\' + m.profileId + '）')

  console.log('\n=== 3. 隔离检测 + 插件扫描 + 档案列表 ===')
  const info1 = detectBepInEx(gameDir)
  if (!info1 || !info1.isIsolated) throw new Error('隔离检测失败')
  const scan = scanPlugins(info1)
  if (scan.plugins.length !== 1 || scan.plugins[0].fileName !== 'FakeMod.dll') throw new Error('插件扫描失败')
  const list = listIsolatedProfiles(gameDir, GAME_NAME)
  if (list.length !== 1 || list[0].name !== '单机档' || list[0].id !== m.profileId) {
    throw new Error('档案列表错误: ' + JSON.stringify(list))
  }
  const cur = currentIsolatedProfile(gameDir, GAME_NAME)
  if (!cur || cur.id !== m.profileId || cur.name !== '单机档') throw new Error('当前档案识别失败')
  console.log('隔离检测/扫描/列表/当前 ✅（name=' + cur.name + '）')

  console.log('\n=== 4. 隔离模式下新建档案 ===')
  const created = createIsolatedProfile(gameDir, GAME_NAME, '纯净档')
  console.log('created id=' + created.profileId + ' -> ' + created.target)
  // 新档案自动切换生效
  const curAfterCreate = currentIsolatedProfile(gameDir, GAME_NAME)
  if (!curAfterCreate || curAfterCreate.id !== created.profileId) {
    throw new Error('新建后未自动切换: ' + JSON.stringify(curAfterCreate))
  }
  // 新档案：框架在、插件/配置为空
  const newBep = join(profileDir(GAME_NAME, gameDir, created.profileId), 'BepInEx')
  if (!existsSync(join(newBep, 'core', 'BepInEx.Unity.IL2CPP.dll'))) {
    throw new Error('新档案缺少框架 core')
  }
  if (existsSync(join(newBep, 'plugins', 'FakeMod.dll'))) {
    throw new Error('新档案不应复制插件')
  }
  if (existsSync(join(newBep, 'config', 'com.fake.mod.cfg'))) {
    throw new Error('新档案不应复制配置')
  }
  const list2 = listIsolatedProfiles(gameDir, GAME_NAME)
  if (list2.length !== 2) throw new Error('档案列表应为 2: ' + JSON.stringify(list2))
  console.log('新建档案 ✅（框架复制、插件/配置为空、自动切换）')

  console.log('\n=== 5. 第二个档案 + 切换 ===')
  const id2 = 'p' + Date.now().toString(36) + 'xyz'
  cpSync(profileDir(GAME_NAME, gameDir, m.profileId), profileDir(GAME_NAME, gameDir, id2), {
    recursive: true
  })
  writeFileSync(
    join(profileDir(GAME_NAME, gameDir, id2), 'profile.json'),
    '{"name":"联机档","createdAt":"2025-01-01"}'
  )
  const s = switchIsolatedProfile(gameDir, GAME_NAME, id2)
  if (!s.target.includes(id2)) throw new Error('切换失败: ' + s.target)
  const cur2 = currentIsolatedProfile(gameDir, GAME_NAME)
  if (!cur2 || cur2.name !== '联机档') throw new Error('切换后识别失败')
  console.log('切换/识别 ✅（当前=' + cur2.name + '）')

  console.log('\n=== 6. 删除档案（当前生效受保护） ===')
  let protectedOk = false
  try {
    removeIsolatedProfile(gameDir, GAME_NAME, id2)
  } catch {
    protectedOk = true // 当前生效档案不可删除
  }
  if (!protectedOk) throw new Error('当前生效档案应受保护')
  // 切回第一个档案后再删除 id2
  switchIsolatedProfile(gameDir, GAME_NAME, m.profileId)
  removeIsolatedProfile(gameDir, GAME_NAME, id2)
  const list3 = listIsolatedProfiles(gameDir, GAME_NAME)
  if (list3.length !== 2 || list3.some((p) => p.id === id2)) {
    throw new Error('删除后列表错误: ' + JSON.stringify(list3))
  }
  console.log('删除档案 ✅（当前生效受保护，非生效档案可删）')

  console.log('\n✅ 插件库验证全部通过')
} finally {
  rmSync(root, { recursive: true, force: true })
}
