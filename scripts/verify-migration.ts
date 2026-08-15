/**
 * 安装版数据迁移验证：模拟打包版（env 数据根 = 安装目录 data）检测两个游戏
 * 注意：数据根为当前安装版位置 E:\trainer\BPM\BepInExManager\data（旧位置
 * E:\trainer\beplnexmanager 已弃用，勿再维护）
 */
process.env.BEPINEX_MANAGER_DATA_DIR = 'E:\\trainer\\BPM\\BepInExManager\\data'

import { detectBepInEx } from '../src/main/core/bepinex'
import { scanLibrary } from '../src/main/core/library'
import { scanPlugins } from '../src/main/core/plugins'

const games = [
  { name: 'DreamEcho', dir: 'E:\\steam\\steamapps\\common\\DreamEcho' },
  { name: 'Pax Autocratica', dir: 'E:\\steam\\steamapps\\common\\Pax Autocratica' }
]

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  cond ? pass++ : fail++
}

for (const g of games) {
  console.log(`\n===== ${g.name} =====`)
  const info = detectBepInEx(g.dir)
  check('隔离模式检测', info?.isIsolated === true, JSON.stringify(info))
  if (!info) continue
  check('rootDir 在当前数据根', info.rootDir.toLowerCase().includes('trainer\\bpm\\bepinexmanager'), info.rootDir)
  const scan = scanPlugins(info)
  check('档案插件扫描', scan.plugins.length >= 1, JSON.stringify(scan.plugins.map((p) => p.fileName)))
  const lib = scanLibrary(g.dir, g.name)
  check('插件库扫描', lib.entries.length >= 1, JSON.stringify(lib.entries.map((e) => e.relPath)))
  check('库目录在当前位置', lib.libraryDir.toLowerCase().includes('trainer\\bpm\\bepinexmanager'), lib.libraryDir)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
