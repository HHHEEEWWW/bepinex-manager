/**
 * 插件元数据解析：调用 tools/plugin-metadata-reader（C# 工具）批量读取
 *
 * C# 工具用 MetadataLoadContext 只读反射，从 dll 的 BepInPlugin / BepInDependency
 * 特性提取 GUID / 名称 / 版本 / 依赖，绝不执行插件代码。
 *
 * 工具首次使用时自动 dotnet build；失败时插件保留 meta=null 并记录 metaError。
 *
 * 工具目录定位策略：环境变量覆盖 → 从 __dirname 逐级向上探测
 * （兼容 dev 打包产物 out/main、独立脚本、正式打包等不同运行位置）。
 */
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import type { BepInExInfo, PluginInfo, PluginMetadata } from '@shared/types'

/**
 * 工具目录定位策略（兼容 dev / 独立脚本 / 正式打包三种布局）：
 *   dev/脚本:   <root>/tools/plugin-metadata-reader/bin/Release/net9.0/plugin-metadata-reader.exe
 *   正式打包:   <installDir>/tools/plugin-metadata-reader/plugin-metadata-reader.exe（publish 单文件）
 * 定位顺序：环境变量 → 从 __dirname 逐级向上找 exe → 找 csproj（可自动构建）
 */
function findTool(): { dir: string; exe: string; buildable: boolean } | null {
  const candidates: string[] = []
  if (process.env.BEPINEX_MANAGER_TOOLS_DIR) {
    candidates.push(process.env.BEPINEX_MANAGER_TOOLS_DIR)
  }
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, 'tools', 'plugin-metadata-reader'))
    dir = dirname(dir)
  }

  for (const c of candidates) {
    // 打包布局：publish 单文件 exe 直接在目录内
    const publishExe = join(c, 'plugin-metadata-reader.exe')
    if (existsSync(publishExe)) return { dir: c, exe: publishExe, buildable: false }
    // dev 布局：bin/Release/net9.0/
    const devExe = join(c, 'bin', 'Release', 'net9.0', 'plugin-metadata-reader.exe')
    if (existsSync(devExe)) return { dir: c, exe: devExe, buildable: false }
    // 源码布局：可触发 dotnet build
    if (existsSync(join(c, 'plugin-metadata-reader.csproj'))) {
      return { dir: c, exe: devExe, buildable: true }
    }
  }
  return null
}

const tool = findTool()

let toolReady: boolean | null = null

/** 确保 C# 工具已构建（只尝试一次，失败则本次会话不再重试） */
function ensureTool(): boolean {
  if (toolReady !== null) return toolReady
  if (!tool) {
    toolReady = false
    return false
  }
  if (existsSync(tool.exe)) {
    toolReady = true
    return true
  }
  if (!tool.buildable) {
    toolReady = false
    return false
  }
  try {
    const r = spawnSync('dotnet', ['build', tool.dir, '-c', 'Release', '--nologo', '-v', 'q'], {
      encoding: 'utf8',
      timeout: 180_000
    })
    toolReady = r.status === 0 && existsSync(tool.exe)
    if (!toolReady && r.stderr) console.error('[metadata] dotnet build failed:', r.stderr.slice(0, 800))
  } catch (e) {
    console.error('[metadata] dotnet build error:', e)
    toolReady = false
  }
  return toolReady
}

/** 批量解析插件元数据（就地写入 plugins 的 meta/metaError 字段） */
export function resolvePluginMetadata(plugins: PluginInfo[], bepinex: BepInExInfo): void {
  if (plugins.length === 0) return
  const dlls = plugins.map((p) => p.fullPath)
  if (!ensureTool()) {
    for (const p of plugins) p.metaError = 'C# 元数据解析工具不可用（需要 .NET SDK 或预构建产物）'
    return
  }

  try {
    const r = spawnSync(
      tool!.exe,
      ['--core', bepinex.coreDir, '--plugins', bepinex.pluginsDir],
      {
        input: dlls.join('\n') + '\n',
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024
      }
    )
    if (r.status !== 0) {
      const err = (r.stderr || '').slice(0, 500)
      for (const p of plugins) p.metaError = `解析工具退出码 ${r.status}: ${err}`
      return
    }

    const byPath = new Map<string, { meta: PluginMetadata | null; error: string | null }>()
    for (const line of r.stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const obj = JSON.parse(t)
        if (typeof obj.path !== 'string') continue
        if (obj.error) {
          byPath.set(obj.path, { meta: null, error: String(obj.error) })
        } else {
          byPath.set(obj.path, {
            meta: {
              guid: String(obj.guid),
              name: String(obj.name),
              version: String(obj.version),
              dependencies: Array.isArray(obj.dependencies) ? obj.dependencies.map(String) : []
            },
            error: null
          })
        }
      } catch {
        /* 忽略无法解析的行 */
      }
    }

    for (const p of plugins) {
      const hit = byPath.get(p.fullPath)
      p.meta = hit?.meta ?? null
      p.metaError = hit?.error ?? null
    }
  } catch (e) {
    for (const p of plugins) p.metaError = `解析异常: ${e}`
  }
}
