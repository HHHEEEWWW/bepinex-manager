/**
 * 拖拽安装 MOD 核心逻辑验证（无需 Electron）：
 * 1. 伪造隔离模式游戏目录（winhttp.dll + doorstop_config.ini + 档案 core）
 * 2. 构造含恶意条目的 zip（路径穿越、危险 exe、非插件文件）
 * 3. 调用 installModsToGame 验证：dll 直装、zip 提取、安全拦截
 * 运行：pnpm exec esbuild scripts/verify-modinstall.ts --bundle --platform=node --format=cjs --outfile=scripts/verify-modinstall.cjs --alias:@shared=./src/shared --external:adm-zip
 *       node scripts/verify-modinstall.cjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { installModsToGame } from '../src/main/core/modinstall'

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

// ---- 构造临时环境 ----
const root = mkdtempSync(join(tmpdir(), 'bm-modinstall-'))
const gameDir = join(root, 'game')
const profile = join(root, 'plugin-library', 'testgame-ab12', 'prof01', 'BepInEx')
mkdirSync(join(gameDir), { recursive: true })
mkdirSync(join(profile, 'core'), { recursive: true })
// 注意：隔离模式游戏目录不允许存在 BepInEx 目录（否则 detectBepInEx 会误判常规模式）

// 假注入件
writeFileSync(join(gameDir, 'winhttp.dll'), 'fake-winhttp')
writeFileSync(
  join(gameDir, 'doorstop_config.ini'),
  '[General]\ntarget_assembly=' + join(profile, 'core', 'BepInEx.Core.dll').replace(/\\/g, '/') + '\n'
)
writeFileSync(join(profile, 'core', 'BepInEx.Core.dll'), 'fake-core')

// 假插件 dll（直接拖拽）
const dllSrc = join(root, 'DirectMod.dll')
writeFileSync(dllSrc, 'MZ-direct-mod-bytes')

// 构造恶意 zip
const zipPath = join(root, 'TestMod.zip')
const zip = new AdmZip()
zip.addFile('TopMod.dll', Buffer.from('MZ-top-mod'))
zip.addFile('BepInEx/plugins/NestedMod.dll', Buffer.from('MZ-nested-mod'))
zip.addFile('../evil.dll', Buffer.from('MZ-evil'))
zip.addFile('hack.exe', Buffer.from('MZ-hack'))
zip.addFile('readme.txt', Buffer.from('hello'))
zip.writeZip(zipPath)

console.log('== installModsToGame 端到端 ==')
const result = installModsToGame(gameDir, [dllSrc, zipPath])

const pluginsDir = join(profile, 'plugins')
check('直接 dll 安装成功', result.installed.some((i) => i.fileName === 'DirectMod.dll'), JSON.stringify(result.installed))
check('DirectMod.dll 已落盘', existsSync(join(pluginsDir, 'DirectMod.dll')))
check('zip 顶层 dll 安装', result.installed.some((i) => i.fileName === 'TopMod.dll'))
check('TopMod.dll 已落盘', existsSync(join(pluginsDir, 'TopMod.dll')))
check('zip BepInEx/plugins 前缀剥离', result.installed.some((i) => i.fileName === 'NestedMod.dll'))
check('NestedMod.dll 已落盘于根', existsSync(join(pluginsDir, 'NestedMod.dll')))
check('路径穿越被拦截', !existsSync(join(gameDir, 'evil.dll')) && !existsSync(join(pluginsDir, '..', 'evil.dll')))
check('危险 exe 被拦截', !existsSync(join(pluginsDir, 'hack.exe')))
check('非插件文件被忽略', !existsSync(join(pluginsDir, 'readme.txt')))
check('忽略项有说明', result.ignored.length > 0, JSON.stringify(result.ignored))
check('无失败项', result.failed.length === 0, JSON.stringify(result.failed))

// ---- 重复安装 = 覆盖更新 ----
console.log('== 重名覆盖 ==')
writeFileSync(dllSrc, 'MZ-direct-mod-v2')
const result2 = installModsToGame(gameDir, [dllSrc])
check('重名 dll 覆盖安装成功', result2.installed.some((i) => i.fileName === 'DirectMod.dll'))
const content = require('fs').readFileSync(join(pluginsDir, 'DirectMod.dll'), 'utf8')
check('文件内容已更新', content === 'MZ-direct-mod-v2', content)

// ---- 不支持格式 ----
console.log('== 不支持格式 ==')
const txtPath = join(root, 'notes.txt')
writeFileSync(txtPath, 'hi')
const result3 = installModsToGame(gameDir, [txtPath])
check('txt 被拒绝', result3.failed.some((i) => i.fileName === 'notes.txt'), JSON.stringify(result3.failed))

// ---- 无 BepInEx 游戏 ----
console.log('== 无 BepInEx ==')
const bareGame = join(root, 'bare-game')
mkdirSync(bareGame, { recursive: true })
try {
  installModsToGame(bareGame, [dllSrc])
  check('无 BepInEx 抛出错误', false)
} catch (err) {
  check('无 BepInEx 抛出错误', (err as Error).message.includes('未检测到'), (err as Error).message)
}

rmSync(root, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
