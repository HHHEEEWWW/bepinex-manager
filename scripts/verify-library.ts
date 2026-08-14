/**
 * 插件库架构验证（无需 Electron）：
 * 1. 伪造隔离游戏（dataRoot 用 BEPINEX_MANAGER_DATA_DIR 指向临时目录）
 * 2. 验证 addFilesToLibrary：dll 顶层条目、zip 条目化（单顶层目录/散文件/BepInEx 前缀）、恶意条目拦截
 * 3. 验证 scanLibrary：自动收集现有档案插件（幂等）
 * 4. 验证 copyEntryToProfile / removeEntryFromProfile
 * 5. 验证 scanPlugins 条目级扫描
 * 运行：node node_modules/.pnpm/esbuild@版本/node_modules/esbuild/bin/esbuild scripts/verify-library.ts --bundle --platform=node --format=cjs --outfile=scripts/verify-library.cjs --alias:@shared=./src/shared --external:adm-zip
 *       （版本号用 pnpm 安装的实际 esbuild 版本替换；注意本注释不能含星号斜杠序列）
 *       node scripts/verify-library.cjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import AdmZip from 'adm-zip'

// 数据根指向临时目录（必须先于 isolation.ts 任何调用）
const tmpRoot = mkdtempSync(join(tmpdir(), 'bm-library-'))
process.env.BEPINEX_MANAGER_DATA_DIR = join(tmpRoot, 'data')

import { detectBepInEx } from '../src/main/core/bepinex'
import { scanPlugins } from '../src/main/core/plugins'
import {
  addFilesToLibrary,
  copyEntryToProfile,
  libraryDirOf,
  removeEntryFromProfile,
  removeLibraryEntry,
  scanLibrary
} from '../src/main/core/library'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.error(`  FAIL  ${name}${detail ? `  -- ${detail}` : ''}`)
  }
}

// ---- 构造临时隔离游戏 ----
const gameDir = join(tmpRoot, 'game')
const profDir = join(tmpRoot, 'data', 'plugin-library', 'testgame-ab12', 'prof01')
const bepDir = join(profDir, 'BepInEx')
mkdirSync(join(gameDir), { recursive: true })
mkdirSync(join(bepDir, 'core'), { recursive: true })
mkdirSync(join(bepDir, 'plugins'), { recursive: true })
mkdirSync(join(bepDir, 'plugins-disabled'), { recursive: true })
mkdirSync(join(bepDir, 'config'), { recursive: true })

writeFileSync(join(gameDir, 'winhttp.dll'), 'fake-winhttp')
writeFileSync(
  join(gameDir, 'doorstop_config.ini'),
  '[General]\ntarget_assembly=' + join(bepDir, 'core', 'BepInEx.Core.dll') + '\n'
)
writeFileSync(join(bepDir, 'core', 'BepInEx.Core.dll'), 'fake-core')
// 现有插件（模拟旧档案已有插件，用于自动收集）
writeFileSync(join(bepDir, 'plugins', 'FakeMod.dll'), 'MZ-fake-mod')
writeFileSync(join(bepDir, 'plugins-disabled', 'DisabledMod.dll'), 'MZ-disabled-mod')
// profile.json
writeFileSync(
  join(profDir, 'profile.json'),
  JSON.stringify({ name: '单机档案', gameName: 'Test Game', createdAt: '2026-01-01T00:00:00.000Z' })
)

const gameName = 'Test Game'
const info = detectBepInEx(gameDir)
check('隔离模式检测', info?.isIsolated === true, JSON.stringify(info))
const libDir = libraryDirOf(gameDir)
check('库目录解析', !!libDir, libDir ?? '')

// ---- 外部文件入库 ----
console.log('== addFilesToLibrary ==')
const directDll = join(tmpRoot, 'DirectMod.dll')
writeFileSync(directDll, 'MZ-direct-mod')

// zip1：单顶层目录条目
const zip1 = join(tmpRoot, 'MyMod.zip')
{
  const z = new AdmZip()
  z.addFile('MyMod/MyMod.dll', Buffer.from('MZ-my-mod'))
  z.addFile('MyMod/config.json', Buffer.from('{"a":1}'))
  z.writeZip(zip1)
}
// zip2：BepInEx/plugins 前缀 + 散文件
const zip2 = join(tmpRoot, 'Scattered.zip')
{
  const z = new AdmZip()
  z.addFile('BepInEx/plugins/Scattered.dll', Buffer.from('MZ-scattered'))
  z.addFile('readme.txt', Buffer.from('hello'))
  z.writeZip(zip2)
}
// zip3：恶意条目（adm-zip addFile 会规范化 ../ 前缀，须直接改写 entryName）
const zip3 = join(tmpRoot, 'Evil.zip')
{
  const z = new AdmZip()
  z.addFile('placeholder.dll', Buffer.from('x'))
  z.getEntries()[0].entryName = '../evil.dll'
  z.addFile('hack.exe', Buffer.from('MZ-hack'))
  z.writeZip(zip3)
}

const addRes = addFilesToLibrary(gameDir, [directDll, zip1, zip2, zip3])
check('dll 顶层入库', addRes.added.some((i) => i.fileName === 'DirectMod.dll'), JSON.stringify(addRes.added))
check('zip 目录条目', addRes.added.some((i) => i.fileName === 'MyMod'), JSON.stringify(addRes.added))
check('zip 前缀剥离顶层条目', addRes.added.some((i) => i.fileName === 'Scattered.dll'))
check('恶意 zip 无成功项', !addRes.added.some((i) => i.fileName.includes('evil') || i.fileName === 'hack.exe'))
check('恶意条目被忽略', addRes.ignored.length > 0, JSON.stringify(addRes.ignored))
check('无失败项', addRes.failed.length === 0, JSON.stringify(addRes.failed))

check('MyMod 资源文件随目录入库', existsSync(join(libDir!, 'MyMod', 'config.json')))
check('evil.dll 未落盘', !existsSync(join(libDir!, 'evil.dll')) && !existsSync(join(gameDir, 'evil.dll')))

// ---- 扫描 + 自动收集 ----
console.log('== scanLibrary（自动收集） ==')
const scan1 = scanLibrary(gameDir, gameName)
check('自动收集现有插件', scan1.collected >= 2, `collected=${scan1.collected}`)
check('库内条目数', scan1.entries.length >= 5, `entries=${scan1.entries.length}`)
check('FakeMod.dll 已入库', scan1.entries.some((e) => e.relPath === 'FakeMod.dll'))
check('DisabledMod.dll 已入库', scan1.entries.some((e) => e.relPath === 'DisabledMod.dll'))

// 幂等：再次扫描不重复收集
const scan2 = scanLibrary(gameDir, gameName)
check('收集幂等', scan2.collected === 0, `collected=${scan2.collected}`)

// ---- 装入档案 ----
console.log('== copyEntryToProfile ==')
const copied = copyEntryToProfile(gameDir, gameName, 'MyMod')
check('装入档案成功', existsSync(join(bepDir, 'plugins', 'MyMod', 'MyMod.dll')), copied)

const scanAfter = scanLibrary(gameDir, gameName)
check('installed 标记', scanAfter.entries.find((e) => e.relPath === 'MyMod')?.installed === true)

// ---- 条目级插件扫描 ----
console.log('== scanPlugins（条目级） ==')
const pluginScan = scanPlugins(info!)
const names = pluginScan.plugins.map((p) => p.fileName).sort()
check('条目级扫描数量', pluginScan.plugins.length >= 3, JSON.stringify(names))
check('目录条目 MyMod 识别', names.includes('MyMod'))
check('目录条目主 dll 找到', pluginScan.plugins.find((p) => p.fileName === 'MyMod')?.mainDllPath?.endsWith('MyMod.dll') === true)
check('禁用条目标记', pluginScan.plugins.find((p) => p.fileName === 'DisabledMod.dll')?.enabled === false)

// ---- 从档案移除 ----
console.log('== removeEntryFromProfile ==')
const removed = removeEntryFromProfile(gameDir, gameName, 'MyMod')
check('移除成功', removed === true)
check('档案中已删除', !existsSync(join(bepDir, 'plugins', 'MyMod')))
check('插件库保留', existsSync(join(libDir!, 'MyMod', 'MyMod.dll')))

// ---- 重名更新 ----
console.log('== 重名覆盖 ==')
writeFileSync(directDll, 'MZ-direct-mod-v2')
const addRes2 = addFilesToLibrary(gameDir, [directDll])
check('重名标记 updated', addRes2.updated.some((i) => i.fileName === 'DirectMod.dll'), JSON.stringify(addRes2.updated))

// ---- 严格幂等：同名不同大小也不建副本 ----
console.log('== 收集严格幂等 ==')
// 修改档案里的 FakeMod.dll（模拟用户更新插件后大小变化）
writeFileSync(join(bepDir, 'plugins', 'FakeMod.dll'), 'MZ-fake-mod-UPDATED-VERSION')
const scan3 = scanLibrary(gameDir, gameName)
check('更新后刷新不产生副本', scan3.collected === 0, `collected=${scan3.collected}`)
check('无 -2 副本条目', !scan3.entries.some((e) => e.relPath.includes('-2')), JSON.stringify(scan3.entries.map((e) => e.relPath)))

// ---- 库条目删除 ----
console.log('== removeLibraryEntry ==')
const delRes = removeLibraryEntry(gameDir, 'Scattered.dll')
check('删除库条目成功', delRes === true)
check('库中已删除', !existsSync(join(libDir!, 'Scattered.dll')))
const scan4 = scanLibrary(gameDir, gameName)
check('删除后库扫描不含该条目', !scan4.entries.some((e) => e.relPath === 'Scattered.dll'))

rmSync(tmpRoot, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
