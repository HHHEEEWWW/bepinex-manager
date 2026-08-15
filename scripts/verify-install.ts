/**
 * 端到端验证 installBepInExToLibrary（干净电脑场景模拟）：
 * 1. 获取真实 BepInEx 6 IL2CPP 资产并下载
 * 2. fake 游戏目录（模拟 IL2CPP 游戏，无任何 BepInEx 痕迹）
 * 3. 跑完整安装 → 验证：游戏目录有 winhttp.dll / dotnet/coreclr.dll / doorstop_config.ini 含 [Il2Cpp]，
 *    BepInEx 整树在插件库，doorstop target 指向档案
 */
process.env.BEPINEX_MANAGER_DATA_DIR = 'E:\\trainer\\beplnexmanager\\BepInExManager\\data'

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { listBepInExReleases, installBepInExToLibrary } from '../src/main/core/installer'
import { detectBepInEx } from '../src/main/core/bepinex'

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  cond ? pass++ : fail++
}

async function main(): Promise<void> {
  // 1) 获取资产
  const releases = await listBepInExReleases('il2cpp')
  check('获取 il2cpp release', releases.length > 0)
  const rel = releases[0]
  const asset = rel.assets[0]
  console.log(`资产: ${asset.name} (${(asset.size / 1048576).toFixed(1)}MB)`)

  // 2) fake 游戏目录（模拟干净电脑上的 IL2CPP 游戏）
  const gameDir = join(process.env.TEMP!, 'bm-fakegame')
  rmSync(gameDir, { recursive: true, force: true })
  mkdirSync(gameDir, { recursive: true })
  writeFileSync(join(gameDir, 'GameAssembly.dll'), 'fake')
  writeFileSync(join(gameDir, 'global-metadata.dat'), 'fake')

  // 3) 完整安装
  console.log('\n== 安装 ==')
  const r = await installBepInExToLibrary(gameDir, 'FakeGame', asset.url, asset.name, (p) => {
    if (p.percent >= 95) console.log(`  [${p.phase}] ${p.message}`)
  })
  check('返回 profileId/target', !!r.profileId && !!r.target, JSON.stringify(r))

  // 4) 验证游戏目录
  console.log('\n== 游戏目录验证 ==')
  check('winhttp.dll', existsSync(join(gameDir, 'winhttp.dll')))
  check('.doorstop_version', existsSync(join(gameDir, '.doorstop_version')))
  check('dotnet/coreclr.dll', existsSync(join(gameDir, 'dotnet', 'coreclr.dll')), 'dotnet 运行时必须复制到游戏目录')
  check('无 BepInEx 文件夹（隔离正常）', !existsSync(join(gameDir, 'BepInEx')))
  const ini = readFileSync(join(gameDir, 'doorstop_config.ini'), 'utf8')
  check('doorstop 含 [Il2Cpp]', ini.includes('[Il2Cpp]'), '缺少 [Il2Cpp] 节会导致 IL2CPP 插件无法加载')
  check('doorstop 含 coreclr_path', /coreclr_path\s*=\s*dotnet\\coreclr\.dll/i.test(ini), 'coreclr_path 必须指向 dotnet\\coreclr.dll')
  check('target 指向档案', ini.includes('plugin-library') && ini.includes('BepInEx.Unity.IL2CPP.dll'))
  check('enabled=true', /enabled\s*=\s*true/i.test(ini))

  // 5) 检测验证（模拟管理器刷新）
  console.log('\n== 检测验证 ==')
  const info = detectBepInEx(gameDir)
  check('隔离模式检测', info?.isIsolated === true, JSON.stringify(info))

  // 6) 清理
  rmSync(gameDir, { recursive: true, force: true })
  // 删除测试档案（保留插件库整洁）
  try {
    const data = 'E:\\trainer\\beplnexmanager\\BepInExManager\\data\\plugin-library'
    const dirs = ['fakegame']
    for (const d of dirs) {
      const root = join(data, d)
      if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    }
  } catch { /* 忽略 */ }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('端到端验证失败:', e)
  process.exit(1)
})
