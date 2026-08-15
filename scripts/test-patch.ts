/**
 * patch-cpp2il 模块单测（本地验证，不依赖网络）
 * 用法：node scripts/test-patch.cjs（esbuild bundle 后）
 * 验证对象：PAX 档案（已补丁）与 DreamEcho 档案（未补丁的对照？——DreamEcho 也是 be.785，
 * 但验证逻辑应一致）。核心断言：
 *   1. resolveCpp2IlPatchDir 找到补丁源
 *   2. 对未修复副本：cpp2ilNeedsPatch=true，applyCpp2IlPatch 后 isCpp2IlPatched=true，备份存在
 *   3. 幂等：再次 apply 返回 already patched
 */
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { applyCpp2IlPatch, cpp2ilNeedsPatch, isCpp2IlPatched, resolveCpp2IlPatchDir } from '../src/main/core/patch-cpp2il'

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  cond ? pass++ : fail++
}

// 补丁源
const patchDir = resolveCpp2IlPatchDir()
check('补丁源存在', !!patchDir, patchDir ?? '')

// 用 PAX 档案 core 的原版备份构造"未修复副本"
const origCore = 'E:\\trainer\\BPM\\BepInExManager\\data\\plugin-library\\pax-autocratica-1f70\\pmsu8pzzmf4bg\\BepInEx\\core'
const bakDir = join(origCore, 'bak-cpp2il-20260815')
const tmp = join(process.env.TEMP!, 'bm-patch-test-' + Date.now())
mkdirSync(join(tmp, 'core'), { recursive: true })
copyFileSync(join(bakDir, 'Cpp2IL.Core.dll'), join(tmp, 'core', 'Cpp2IL.Core.dll'))
copyFileSync(join(bakDir, 'LibCpp2IL.dll'), join(tmp, 'core', 'LibCpp2IL.dll'))

check('未修复副本被识别', cpp2ilNeedsPatch(tmp) === true)
check('未修复副本未生效', isCpp2IlPatched(tmp) === false)

const r1 = applyCpp2IlPatch(tmp)
check('首次 apply 成功', r1.applied === true, r1.reason)
check('apply 后已生效', isCpp2IlPatched(tmp) === true)
check('apply 后不再需要补丁', cpp2ilNeedsPatch(tmp) === false)
const baks = readdirSync(join(tmp, 'core')).filter((d) => d.startsWith('bak-cpp2il-'))
check('备份目录存在', baks.length > 0, baks.join(', '))
check('备份内容完整', existsSync(join(tmp, 'core', baks[0] ?? '', 'Cpp2IL.Core.dll')) && existsSync(join(tmp, 'core', baks[0] ?? '', 'LibCpp2IL.dll')))

const r2 = applyCpp2IlPatch(tmp)
check('二次 apply 幂等跳过', r2.applied === false && r2.reason.includes('already'), r2.reason)

// 对已补丁档案（PAX 现档案）验证：不应重复打补丁
const paxLive = 'E:\\trainer\\BPM\\BepInExManager\\data\\plugin-library\\pax-autocratica-1f70\\pmsu8pzzmf4bg\\BepInEx'
check('PAX 现档案已生效', isCpp2IlPatched(paxLive) === true)
check('PAX 现档案 apply 跳过', applyCpp2IlPatch(paxLive).applied === false)

// 清理
rmSync(tmp, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
