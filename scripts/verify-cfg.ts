/**
 * cfg 解析/序列化验证
 * 用法：node scripts/verify-cfg.cjs（先 esbuild 打包）
 */
import { parseCfg, serializeCfg } from '../src/shared/cfgparser'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { discoverGames } from '../src/main/core/games'

// ---- fixture 测试 ----
const fixture = [
  '## Settings file was created by plugin DreamEchoMod v0.1.0',
  '## Plugin GUID: com.dreamecho.mod',
  '',
  '[General]',
  '',
  '## 是否启用功能',
  '# Setting type: Boolean',
  '# Default value: true',
  'EnableFeature = true',
  '',
  '[Damage]',
  '',
  '## 掉落倍率',
  '# Setting type: Single',
  '# Default value: 2',
  'DropMultiplier = 3.5',
  '',
  '## 稀有度偏好',
  '# Setting type: Enum',
  '# Acceptable values: Common, Rare, Epic, Legendary',
  '# Default value: Rare',
  'RarityPreference = Epic'
].join('\n')

const doc = parseCfg(fixture)
console.log(`fixture: ${doc.sections.length} 个 section`)
if (doc.sections.length !== 2) throw new Error('section 数量错误')
if (doc.headerLines.length !== 2) throw new Error('header 行数错误: ' + doc.headerLines.length)

const general = doc.sections[0]
const enable = general.entries[0]
if (enable.key !== 'EnableFeature' || enable.settingType !== 'Boolean' || enable.value !== 'true') {
  throw new Error('Boolean 条目解析错误: ' + JSON.stringify(enable))
}
if (enable.defaultValue !== 'true') throw new Error('默认值解析错误')

const dmg = doc.sections[1]
const mult = dmg.entries[0]
if (mult.settingType !== 'Single' || mult.value !== '3.5') throw new Error('Single 条目解析错误')
const rarity = dmg.entries[1]
if (rarity.settingType !== 'Enum' || rarity.acceptableValues?.length !== 4 || rarity.value !== 'Epic') {
  throw new Error('Enum 条目解析错误: ' + JSON.stringify(rarity))
}
console.log('fixture 解析 ✅')

// 序列化回写再解析，验证不丢数据
const round = parseCfg(serializeCfg(doc))
if (round.sections.length !== 2 || round.sections[1].entries[1].value !== 'Epic') {
  throw new Error('序列化往返失败')
}
console.log('序列化往返 ✅')

// ---- 真实 cfg ----
let realChecked = false
for (const g of discoverGames().filter((x) => x.bepinex)) {
  const cfgDir = g.bepinex.configDir
  if (!existsSync(cfgDir)) continue
  for (const f of readdirSync(cfgDir).filter((x) => x.endsWith('.cfg')).slice(0, 2)) {
    const text = readFileSync(join(cfgDir, f), 'utf8')
    const d = parseCfg(text)
    const entries = d.sections.reduce((n, s) => n + s.entries.length, 0)
    console.log(`真实 cfg: ${g.name}/${f} -> ${d.sections.length} sections, ${entries} 条目`)
    if (entries === 0) throw new Error(`真实 cfg 解析出 0 条目: ${f}`)
    realChecked = true
  }
}
if (!realChecked) console.log('（没有找到真实 cfg 文件，跳过真实验证）')

console.log('\n✅ cfg 解析验证全部通过')
