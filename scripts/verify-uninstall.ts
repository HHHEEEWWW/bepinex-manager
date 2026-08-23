/**
 * BepInEx 卸载验证：临时目录模拟游戏，不碰真实游戏
 * 覆盖：常规模式计划 / 隔离模式计划 / dotnet 特征保护 / 执行删除后的还原断言
 * 用法：npx esbuild scripts/verify-uninstall.ts --bundle --platform=node --outfile=scripts/verify-uninstall.cjs && node scripts/verify-uninstall.cjs
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectBepInEx } from '../src/main/core/bepinex'
import { migrateToIsolated, createIsolatedProfile, pluginsRootDir } from '../src/main/core/isolation'
import { planUninstall, pruneGameLibrary, libraryRoot } from '../src/main/core/uninstaller'

const root = join(tmpdir(), 'bepinex-uninstall-test-' + Date.now())
const gameDir = join(root, 'game')
const dataDir = join(root, 'data')
const GAME_NAME = 'Test Game 测试'
process.env.BEPINEX_MANAGER_DATA_DIR = dataDir

function write(p: string, content = 'x'): void {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

function makeRegularGame(withDotnet: boolean): void {
  mkdirSync(join(gameDir, 'BepInEx', 'core'), { recursive: true })
  mkdirSync(join(gameDir, 'BepInEx', 'plugins'), { recursive: true })
  write(join(gameDir, 'BepInEx', 'core', 'BepInEx.Core.dll'))
  write(join(gameDir, 'BepInEx', 'core', 'BepInEx.Unity.IL2CPP.dll'))
  write(join(gameDir, 'winhttp.dll'), 'fake-doorstop')
  write(join(gameDir, '.doorstop_version'), '4.0.0')
  write(
    join(gameDir, 'doorstop_config.ini'),
    '[General]\nenabled=true\ntarget_assembly=BepInEx\\core\\BepInEx.Unity.IL2CPP.dll\n'
  )
  if (withDotnet) {
    // 带 BepInEx 随包运行时特征
    write(join(gameDir, 'dotnet', 'coreclr.dll'))
    write(join(gameDir, 'dotnet', 'hostfxr.dll'))
  }
}

/** 模拟 IPC 层的执行段：逐项 rmSync（purge 模式） */
function executePurge(): string[] {
  const removed: string[] = []
  for (const t of planUninstall(gameDir, GAME_NAME)) {
    rmSync(t.path, { recursive: true, force: true })
    removed.push(t.path)
  }
  pruneGameLibrary(gameDir, GAME_NAME)
  return removed
}

let failed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failed++
    console.error('❌ ' + msg)
  } else {
    console.log('✅ ' + msg)
  }
}

try {
  // ---------- 场景 A：常规模式 + dotnet 特征 ----------
  console.log('=== 场景 A：常规模式卸载计划 ===')
  makeRegularGame(true)
  const infoA = detectBepInEx(gameDir)
  assert(!!infoA && !infoA.isIsolated, '常规模式检测到安装')
  const planA = planUninstall(gameDir, GAME_NAME)
  const kindsA = planA.map((t) => t.kind)
  assert(kindsA.filter((k) => k === 'injector').length === 3, '计划含 3 个注入件（winhttp/ini/version）')
  assert(planA.some((t) => t.kind === 'runtime' && t.path.endsWith('dotnet')), '计划含 dotnet 运行时（特征命中）')
  assert(planA.some((t) => t.kind === 'data' && t.path === join(gameDir, 'BepInEx')), '计划含 BepInEx 主目录')
  const removedA = executePurge()
  assert(removedA.length === planA.length && !existsSync(join(gameDir, 'winhttp.dll')), '执行后注入件已移除')
  assert(!existsSync(join(gameDir, 'BepInEx')) && !existsSync(join(gameDir, 'dotnet')), '执行后数据树与 dotnet 已移除')
  assert(detectBepInEx(gameDir) === null, '卸载后检测为未安装')

  // ---------- 场景 B：隔离模式双档案 ----------
  console.log('\n=== 场景 B：隔离模式卸载计划 ===')
  makeRegularGame(false)
  migrateToIsolated(gameDir, GAME_NAME, '主档')
  createIsolatedProfile(gameDir, GAME_NAME, '测试档')
  const infoB = detectBepInEx(gameDir)
  assert(!!infoB && infoB.isIsolated, '迁移后处于隔离模式')
  const libRoot = pluginsRootDir()
  const profileCountBefore = readdirSync(
    libRoot.split('plugin-library')[0] + 'plugin-library'
  ).length
  const planB = planUninstall(gameDir, GAME_NAME)
  assert(planB.some((t) => t.kind === 'data' && t.path.startsWith(libraryRoot())), '计划指向插件库档案目录')
  assert(
    planB.filter((t) => t.kind === 'data').length === 2,
    `计划含全部 2 个档案（实际 ${planB.filter((t) => t.kind === 'data').length}）`
  )
  assert(!planB.some((t) => t.path.endsWith('dotnet')), '无 dotnet 特征时不列入计划')
  executePurge()
  const gameRootAfter = readdirSync(libRoot)
  assert(gameRootAfter.length === 0 || gameRootAfter.length < profileCountBefore, '插件库空游戏目录壳已清理')
  assert(!existsSync(join(gameDir, 'doorstop_config.ini')), '隔离模式注入件已移除')
  assert(detectBepInEx(gameDir) === null, '隔离模式卸载后检测为未安装')

  // ---------- 场景 C：dotnet 特征保护 ----------
  console.log('\n=== 场景 C：非 BepInEx dotnet 目录保护 ===')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(gameDir, { recursive: true })
  makeRegularGame(false)
  write(join(gameDir, 'dotnet', 'somegame.dat')) // 无 CoreCLR 特征
  const planC = planUninstall(gameDir, GAME_NAME)
  assert(!planC.some((t) => t.path.endsWith('dotnet')), '无特征 dotnet 目录不误删')

  console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (e) {
  console.error('验证异常:', e)
  process.exitCode = 1
} finally {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* 忽略清理失败 */
  }
}
