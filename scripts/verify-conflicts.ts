/**
 * 冲突检测验证（纯函数 fixture 测试）
 * 用法：node scripts/verify-conflicts.cjs（先 esbuild 打包）
 */
import { detectConflicts } from '../src/main/core/plugins'
import type { PluginInfo } from '../src/shared/types'

function mk(id: string, fileName: string, enabled: boolean, guid?: string): PluginInfo {
  return {
    id,
    fileName,
    relPath: id,
    fullPath: 'C:\\x\\' + id,
    sizeBytes: 1,
    enabled,
    meta: guid ? { guid, name: fileName, version: '1.0.0', dependencies: [] } : null,
    configFile: null,
    metaError: null
  }
}

const cases: Array<{ name: string; plugins: PluginInfo[]; expect: number; kinds?: string[] }> = [
  {
    name: '正常无冲突',
    plugins: [mk('A.dll', 'A.dll', true, 'g1'), mk('B.dll', 'B.dll', true, 'g2')],
    expect: 0
  },
  {
    name: '两个启用插件同 GUID',
    plugins: [mk('A.dll', 'A.dll', true, 'dup'), mk('B.dll', 'B.dll', true, 'dup')],
    expect: 1,
    kinds: ['duplicate-guid']
  },
  {
    name: '同 GUID 但其中一个禁用（不算冲突）',
    plugins: [mk('A.dll', 'A.dll', true, 'dup'), mk('B.dll', 'B.dll', false, 'dup')],
    expect: 0
  },
  {
    name: '不同目录同名 dll',
    plugins: [mk('lib/A.dll', 'A.dll', true), mk('mod2/A.dll', 'A.dll', true)],
    expect: 1,
    kinds: ['duplicate-file']
  },
  {
    name: '同 GUID + 同名 dll 同时存在',
    plugins: [
      mk('A.dll', 'helper.dll', true, 'dup'),
      mk('B.dll', 'helper.dll', true, 'dup'),
      mk('C.dll', 'C.dll', true, 'g3')
    ],
    expect: 2,
    kinds: ['duplicate-guid', 'duplicate-file']
  }
]

let failed = 0
for (const c of cases) {
  const result = detectConflicts(c.plugins)
  const ok = result.length === c.expect
  const kindsOk = c.kinds ? c.kinds.every((k) => result.some((r) => r.kind === k)) : true
  console.log(`[${ok && kindsOk ? 'PASS' : 'FAIL'}] ${c.name} -> ${result.length} 个冲突`)
  if (!ok || !kindsOk) {
    failed++
    for (const r of result) console.log(`     ${r.kind}: ${r.message}`)
  }
}

console.log(failed === 0 ? '\n✅ 冲突检测全部通过' : `\n❌ ${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
