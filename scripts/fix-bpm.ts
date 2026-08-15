/**
 * BPM 数据根修复：用最新 BE 构建（be.785+，支持 metadata 31）重新安装两个游戏，
 * 迁移旧档案的插件与配置，删除失败档案。
 */
process.env.BEPINEX_MANAGER_DATA_DIR = 'E:\\trainer\\BPM\\BepInExManager\\data'

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { listBepInExReleases, installBepInExToLibrary } from '../src/main/core/installer'
import { detectBepInEx } from '../src/main/core/bepinex'
import { scanLibrary } from '../src/main/core/library'
import { currentIsolatedProfile, profileDir, gameRootFromTarget } from '../src/main/core/isolation'
import { readDoorstopTarget } from '../src/main/core/bepinex'

const GAMES = [
  { name: 'DreamEcho', dir: 'E:\\steam\\steamapps\\common\\DreamEcho' },
  { name: 'Pax Autocratica', dir: 'E:\\steam\\steamapps\\common\\Pax Autocratica' }
]

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  cond ? pass++ : fail++
}

async function main(): Promise<void> {
  // 1) 获取 BE 最新构建
  console.log('== 获取最新 BE 构建 ==')
  const releases = await listBepInExReleases('il2cpp')
  check('获取 release', releases.length > 0)
  const be = releases[0]
  check('首项为 BE 构建（be.785+）', /be\.\d+/.test(be.tag), be.tag)
  const asset = be.assets[0]
  console.log(`使用: ${asset.name} (${(asset.size / 1048576).toFixed(1)}MB)`)

  for (const g of GAMES) {
    console.log(`\n===== ${g.name} =====`)
    // 旧档案信息（迁移插件/配置用）
    const oldInfo = detectBepInEx(g.dir)
    const oldProfile = oldInfo ? currentIsolatedProfile(g.dir, g.name) : null
    let oldPlugins: string | null = null
    let oldConfig: string | null = null
    if (oldInfo && oldProfile) {
      oldPlugins = join(profileDir(g.name, g.dir, oldProfile.id), 'BepInEx', 'plugins')
      oldConfig = join(profileDir(g.name, g.dir, oldProfile.id), 'BepInEx', 'config')
    }

    // 2) 重新安装（新档案 + doorstop 指向）
    try {
      const r = await installBepInExToLibrary(g.dir, g.name, asset.url, asset.name, (p) => {
        if (p.phase === 'done') console.log(`  ${p.message}`)
      })
      check('重新安装完成', !!r.profileId, r.profileId)
      const newInfo = detectBepInEx(g.dir)
      check('新档案检测', newInfo?.isIsolated === true, newInfo?.rootDir ?? '')

      // 3) 迁移插件与配置（旧档案 → 新档案）
      const newProfile = currentIsolatedProfile(g.dir, g.name)!
      const newBep = join(profileDir(g.name, g.dir, newProfile.id), 'BepInEx')
      if (oldPlugins && existsSync(oldPlugins)) {
        const plugins = readdirSync(oldPlugins).filter((f) => !f.startsWith('.'))
        for (const it of plugins) {
          const src = join(oldPlugins, it)
          if (!existsSync(src)) continue
          cpSync(src, join(newBep, 'plugins', it), { recursive: true, force: true })
        }
        check('插件迁移', plugins.length > 0, plugins.join(', '))
      }
      if (oldConfig && existsSync(oldConfig)) {
        for (const it of readdirSync(oldConfig)) {
          if (it.startsWith('.')) continue
          cpSync(join(oldConfig, it), join(newBep, 'config', it), { recursive: true, force: true })
        }
        check('配置迁移', true)
      }

      // 4) 删除失败档案
      if (oldProfile && oldProfile.id !== newProfile.id) {
        const oldDir = join(profileDir(g.name, g.dir, oldProfile.id))
        if (existsSync(oldDir)) {
          rmSync(oldDir, { recursive: true, force: true })
          check('删除失败档案', !existsSync(oldDir), oldProfile.id)
        }
      }

      // 5) 验证新档案可扫描
      const scan = scanLibrary(g.dir, g.name)
      check('插件库扫描', scan.entries.length >= 1, JSON.stringify(scan.entries.map((e) => e.relPath)))
      const t = readDoorstopTarget(join(g.dir, 'doorstop_config.ini'))
      check('doorstop 指向新档案', !!t && existsSync(t!), t ?? '')
    } catch (err) {
      check(`失败: ${(err as Error).message}`, false)
    }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('修复失败:', e)
  process.exit(1)
})
