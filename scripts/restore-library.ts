/**
 * 一键恢复插件库（数据事故后重建）：
 * 1. 对两个游戏安装 BepInEx 6 IL2CPP（最新 release，直装插件库 + 创建默认档案 + 修正 doorstop）
 * 2. 把本地构建的插件复制进插件库与档案
 * 运行：bundle + node（数据根用 BEPINEX_MANAGER_DATA_DIR 指向安装版 data）
 */
process.env.BEPINEX_MANAGER_DATA_DIR = 'E:\\trainer\\beplnexmanager\\BepInExManager\\data'

import { existsSync, mkdirSync, cpSync, copyFileSync } from 'fs'
import { join } from 'path'
import { listBepInExReleases, installBepInExToLibrary } from '../src/main/core/installer'
import { detectBepInEx } from '../src/main/core/bepinex'
import { scanLibrary } from '../src/main/core/library'
import { currentIsolatedProfile, profileDir, gameRootFromTarget, pluginsRootDir } from '../src/main/core/isolation'
import { readDoorstopTarget } from '../src/main/core/bepinex'

const GAMES = [
  { name: 'DreamEcho', dir: 'E:\\steam\\steamapps\\common\\DreamEcho' },
  { name: 'Pax Autocratica', dir: 'E:\\steam\\steamapps\\common\\Pax Autocratica' }
]

const PAX_SRC = 'E:\\deepseekharness\\BeplnEx-mod-workplace\\paxautocratica-mod\\src\\PaxAutocraticaHelper\\bin\\Release\\net6.0'
const DREAM_SRC = 'E:\\deepseekharness\\BeplnEx-mod-workplace\\dreamecho-mod\\src\\DreamEchoMod\\bin\\Release\\net6.0'

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  cond ? pass++ : fail++
}

async function main(): Promise<void> {
  // 1) 获取 BepInEx 6 IL2CPP 最新资产
  console.log('== 获取 BepInEx 6 IL2CPP 资产 ==')
  const releases = await listBepInExReleases('il2cpp')
  check('获取到 release', releases.length > 0, `count=${releases.length}`)
  const rel = releases[0]
  check('有匹配资产', rel.assets.length > 0, JSON.stringify(rel.assets.map((a) => a.name)))
  const asset = rel.assets[0]
  console.log(`使用: ${asset.name} (${(asset.size / 1048576).toFixed(1)}MB)`)

  // 2) 逐个游戏安装
  for (const g of GAMES) {
    console.log(`\n===== ${g.name} =====`)
    try {
      const r = await installBepInExToLibrary(g.dir, g.name, asset.url, asset.name, (p) => {
        if (p.percent % 25 === 0 || p.phase === 'done') console.log(`  [${p.phase}] ${p.message}`)
      })
      check('BepInEx 安装完成', !!r.profileId, JSON.stringify(r))
      // 安装后目标存在？
      const target = readDoorstopTarget(join(g.dir, 'doorstop_config.ini'))
      check('doorstop 已指向新档案', !!target && existsSync(target), target ?? '')
    } catch (err) {
      check(`安装失败: ${(err as Error).message}`, false)
    }
  }

  // 3) 复制插件进库 + 档案
  console.log('\n== 安装插件 ==')
  for (const g of GAMES) {
    const info = detectBepInEx(g.dir)
    if (!info) {
      check(`${g.name} 检测失败`, false)
      continue
    }
    const libDir = join(pluginsRootDir(), 'game-tmp') // 占位，下面重算
    // 从 doorstop 反推 gameRoot
    const target = readDoorstopTarget(join(g.dir, 'doorstop_config.ini'))!
    const gameRoot = gameRootFromTarget(target)!
    const lib = join(gameRoot, '_library')
    mkdirSync(lib, { recursive: true })

    if (g.name === 'Pax Autocratica') {
      // Pax：目录条目 PaxAutocraticaHelper/（dll + deps.json + pdb）
      const entryDir = join(lib, 'PaxAutocraticaHelper')
      mkdirSync(entryDir, { recursive: true })
      if (existsSync(PAX_SRC)) {
        cpSync(PAX_SRC, entryDir, { recursive: true, filter: (f) => /\.(dll|json|pdb)$/i.test(f) })
      }
      // 装入当前档案
      const current = currentIsolatedProfile(g.dir, g.name)!
      const profPlugins = join(profileDir(g.name, g.dir, current.id), 'BepInEx', 'plugins', 'PaxAutocraticaHelper')
      mkdirSync(profPlugins, { recursive: true })
      if (existsSync(PAX_SRC)) {
        cpSync(PAX_SRC, profPlugins, { recursive: true, filter: (f) => /\.(dll|json|pdb)$/i.test(f) })
      }
      check('Pax 插件入库+入档', existsSync(join(profPlugins, 'PaxAutocraticaHelper.dll')))
    } else {
      // DreamEcho：文件条目 DreamEchoMod.dll
      const dll = join(DREAM_SRC, 'DreamEchoMod.dll')
      if (existsSync(dll)) {
        copyFileSync(dll, join(lib, 'DreamEchoMod.dll'))
        const current = currentIsolatedProfile(g.dir, g.name)!
        const profPlugins = join(profileDir(g.name, g.dir, current.id), 'BepInEx', 'plugins')
        mkdirSync(profPlugins, { recursive: true })
        copyFileSync(dll, join(profPlugins, 'DreamEchoMod.dll'))
      }
      check('DreamEcho 插件入库+入档', existsSync(join(profileDir('DreamEcho', g.dir, currentIsolatedProfile(g.dir, g.name)!.id), 'BepInEx', 'plugins', 'DreamEchoMod.dll')))
    }

    // 4) 验证扫描
    const libScan = scanLibrary(g.dir, g.name)
    check('插件库扫描正常', libScan.entries.length >= 1, JSON.stringify(libScan.entries.map((e) => e.relPath)))
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('恢复失败:', e)
  process.exit(1)
})
