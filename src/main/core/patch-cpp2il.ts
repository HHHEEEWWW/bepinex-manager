/**
 * Cpp2IL Unity 6 兼容补丁
 *
 * 问题：Unity 6 (6000.x) 大游戏的 Il2CppMetadataRegistration 计数字段可超过
 * Cpp2IL 写死的 sanity limit 0xC0000（786,432），导致 metareg 定位失败、
 * interop 生成报 "Failed to find code registration or metadata registration!"。
 * 典型：Pax Autocratica 2026-08-15 更新（Unity 6000.0.37f1）后 metareg 计数
 * 0xCFE2E/0xD04C4（约 85 万）> 0xC0000。上游 Cpp2IL 未修复（issue #500）。
 *
 * 方案：be.785 内置的同版本 Cpp2IL（development.1452，commit 558ddd9）
 * 仅修改 BinarySearcher.cs 的 sanity limit（0xC0000 → 0x400000）后重编译，
 * 在 BepInEx 落档案后自动替换 core/ 下的 Cpp2IL.Core.dll + LibCpp2IL.dll。
 *
 * 检测：原版 ProductVersion = "2022.1.0-development.1452+558ddd9..."，
 * 补丁版 = "2022.1.0+558ddd9..."。以 UTF-16 标记 'development.1452+558ddd9'
 * 是否存在判断是否未修复原版——未来上游发布修复版（版本号变化）时
 * 标记自然消失，补丁自动退役，不会误覆盖。
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'fs'
import { join, dirname } from 'path'

/** 未修复原版的版本标记（UTF-16 存在于 Cpp2IL.Core.dll 的 VersionInfo 中） */
const UNPATCHED_MARK = 'development.1452+558ddd9'

/** 需要替换的 core 文件 */
const PATCH_FILES = ['Cpp2IL.Core.dll', 'LibCpp2IL.dll'] as const

/**
 * 解析补丁 DLL 来源目录（打包版 resources/tools/cpp2il-patch，
 * dev/脚本版项目根 tools/cpp2il-patch，均可被环境变量覆盖）。
 */
export function resolveCpp2IlPatchDir(): string | null {
  const candidates: string[] = []
  if (process.env.BEPINEX_MANAGER_CPP2IL_PATCH_DIR) {
    candidates.push(process.env.BEPINEX_MANAGER_CPP2IL_PATCH_DIR)
  }
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'tools', 'cpp2il-patch'))
  }
  // dev：cwd 上溯找项目根（electron-vite dev 从项目根启动）
  for (let depth = 0; depth < 4; depth++) {
    const up = depth === 0 ? process.cwd() : join(process.cwd(), ...Array(depth).fill('..'))
    candidates.push(join(up, 'tools', 'cpp2il-patch'))
  }
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'Cpp2IL.Core.dll')) && existsSync(join(dir, 'LibCpp2IL.dll'))) {
      return dir
    }
  }
  return null
}

/** 判断档案 BepInEx/core 下的 Cpp2IL.Core.dll 是否为未修复原版（需要打补丁） */
export function cpp2ilNeedsPatch(bepInExDir: string): boolean {
  const dll = join(bepInExDir, 'core', 'Cpp2IL.Core.dll')
  if (!existsSync(dll)) return false
  try {
    const buf = readFileSync(dll)
    const mark = Buffer.from(UNPATCHED_MARK, 'utf16le')
    return buf.includes(mark)
  } catch {
    return false
  }
}

/**
 * 对档案 BepInEx 树应用 Cpp2IL 兼容补丁（备份原文件到 core/bak-cpp2il-<ts>/）。
 * 幂等：已补丁（标记消失）或补丁源缺失时跳过。
 */
export function applyCpp2IlPatch(bepInExDir: string): { applied: boolean; reason: string } {
  const coreDir = join(bepInExDir, 'core')
  const dll = join(coreDir, 'Cpp2IL.Core.dll')
  if (!existsSync(dll)) return { applied: false, reason: 'no Cpp2IL.Core.dll (mono or old version)' }
  if (!cpp2ilNeedsPatch(bepInExDir)) {
    return { applied: false, reason: 'already patched or unknown version' }
  }
  const patchDir = resolveCpp2IlPatchDir()
  if (!patchDir) {
    return { applied: false, reason: 'patch sources not found (tools/cpp2il-patch)' }
  }

  // 备份原文件
  const bakDir = join(coreDir, `bak-cpp2il-${Date.now()}`)
  mkdirSync(bakDir, { recursive: true })
  for (const f of PATCH_FILES) {
    const src = join(coreDir, f)
    if (existsSync(src)) copyFileSync(src, join(bakDir, f))
  }

  // 替换
  for (const f of PATCH_FILES) {
    copyFileSync(join(patchDir, f), join(coreDir, f))
  }
  return { applied: true, reason: `patched -> backup in ${dirname(bakDir)}` }
}

/** 供验证脚本使用的干净入口：应用后返回是否已生效 */
export function isCpp2IlPatched(bepInExDir: string): boolean {
  return !cpp2ilNeedsPatch(bepInExDir) && existsSync(join(bepInExDir, 'core', 'Cpp2IL.Core.dll'))
}

export { UNPATCHED_MARK }
