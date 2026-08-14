/**
 * installer 兜底逻辑快速验证
 * 用法：node scripts/verify-installer.cjs（先 esbuild 打包）
 * 验证：API 限流(403)时返回内置兜底版本列表
 */
import { listBepInExReleases } from '../src/main/core/installer'

async function main(): Promise<void> {
  // 清缓存强制走网络/兜底路径
  const { rmSync } = await import('fs')
  const { join } = await import('path')
  const cacheDir = join(process.env.TEMP ?? '.', 'bepinex-manager-cache')
  rmSync(cacheDir, { recursive: true, force: true })

  for (const rt of ['il2cpp', 'mono'] as const) {
    const rels = await listBepInExReleases(rt)
    const withAssets = rels.filter((r) => r.assets.length > 0)
    console.log(`runtime=${rt}: ${rels.length} 个 release，可安装 ${withAssets.length} 个`)
    for (const r of withAssets.slice(0, 3)) {
      console.log(`  ${r.tag}${r.prerelease ? ' (pre)' : ''} -> ${r.assets.map((a) => a.name).join(', ')}`)
    }
    if (withAssets.length === 0) throw new Error(`runtime=${rt} 无可用资产`)
  }
  console.log('\n✅ installer 兜底验证通过（API 或兜底列表至少一路可用）')
}

main().catch((e) => {
  console.error('验证失败:', e)
  process.exit(1)
})
