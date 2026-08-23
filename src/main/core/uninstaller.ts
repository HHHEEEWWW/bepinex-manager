/**
 * BepInEx 一键卸载（把游戏目录还原为未安装状态）
 *
 * 卸载内容分三类：
 *   1. 注入件（游戏目录）：winhttp.dll、doorstop_config.ini(+.bak)、.doorstop_version
 *   2. Doorstep .NET 运行时（游戏目录）：dotnet/ —— 仅当其内容为 BepInEx 随包分发
 *      的 CoreCLR 运行时（coreclr.dll / hostfxr.dll / nethost.dll 特征）才移除，
 *      避免误删游戏自带的同名目录。
 *   3. BepInEx 数据树：
 *      - 常规模式：<gameDir>/BepInEx 整树（框架 + 插件 + 配置都在其中）
 *      - 隔离模式：插件库中该游戏的全部档案（注入件移除后档案已无入口）
 *
 * 本模块只负责"计划"（列出要删什么），实际删除由 IPC 层执行
 * （回收站 = electron shell.trashItem；彻底删除 = fs.rmSync），
 * 保持核心逻辑不依赖 electron、可被 scripts/verify-* 单测复用。
 */
import { existsSync, readdirSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { detectBepInEx, readDoorstopTarget } from './bepinex'
import { gamePluginsRootDir, gameRootFromTarget, listIsolatedProfiles, pluginsRootDir } from './isolation'

/** 卸载目标（一项 = 一个文件或目录） */
export interface UninstallTarget {
  /** 绝对路径 */
  path: string
  /** 类别：injector=注入件 / runtime=dotnet 运行时 / data=BepInEx 数据树或档案 */
  kind: 'injector' | 'runtime' | 'data'
  /** 中文描述（UI/日志展示） */
  label: string
}

/** 游戏目录内的 Doorstop 注入件（含迁移备份 doorstop_config.ini.bak） */
const INJECTOR_FILES = ['winhttp.dll', 'doorstop_config.ini', 'doorstop_config.ini.bak', '.doorstop_version']

/** dotnet 目录被视为 BepInEx 随包运行时的特征文件 */
const DOTNET_RUNTIME_SIGNATURES = ['coreclr.dll', 'hostfxr.dll', 'nethost.dll']

/**
 * 生成卸载计划。未检测到 BepInEx 安装时抛错（UI 按钮仅在已检测到时显示）。
 * 目标顺序：注入件 → dotnet 运行时 → 数据树（先摘注入件，数据树失败时不影响游戏还原）。
 */
export function planUninstall(gameDir: string, gameName: string): UninstallTarget[] {
  const info = detectBepInEx(gameDir)
  if (!info) throw new Error(`未在 ${gameDir} 检测到 BepInEx 安装`)

  const targets: UninstallTarget[] = []

  // 1. 注入件（两种模式都在游戏目录）
  for (const f of INJECTOR_FILES) {
    const p = join(gameDir, f)
    if (existsSync(p)) targets.push({ path: p, kind: 'injector', label: `注入件 ${f}` })
  }

  // 2. dotnet 运行时（BepInEx 6 IL2CPP 需要；带特征保护防误删）
  const dotnetDir = join(gameDir, 'dotnet')
  if (isBepInExDotnetRuntime(dotnetDir)) {
    targets.push({ path: dotnetDir, kind: 'runtime', label: 'dotnet/ 运行时（Doorstop CoreCLR）' })
  }

  // 3. BepInEx 数据树
  if (!info.isIsolated) {
    // 常规模式：整树在游戏目录（rootDir 即 gameDir/BepInEx）
    if (existsSync(info.rootDir)) {
      targets.push({ path: info.rootDir, kind: 'data', label: 'BepInEx 主目录（含插件与配置）' })
    }
  } else {
    // 隔离模式：删除该游戏在插件库中的全部档案（含当前生效档案）
    for (const p of listIsolatedProfiles(gameDir, gameName)) {
      targets.push({
        path: join(resolveGameLibRoot(gameDir, gameName), p.id),
        kind: 'data',
        label: `插件库档案「${p.name}」`
      })
    }
  }

  return targets
}

/** 判断 gameDir/dotnet 是否为 BepInEx 随包的 CoreCLR 运行时（特征文件存在） */
export function isBepInExDotnetRuntime(dotnetDir: string): boolean {
  if (!existsSync(dotnetDir)) return false
  return DOTNET_RUNTIME_SIGNATURES.some((f) => existsSync(join(dotnetDir, f)))
}

/** 解析该游戏在插件库中的根目录（与 isolation.resolveGamePluginsRoot 同逻辑，此处独立实现避免导出扩散） */
function resolveGameLibRoot(gameDir: string, gameName: string): string {
  try {
    const target = readDoorstopTarget(join(gameDir, 'doorstop_config.ini'))
    if (target) {
      const derived = gameRootFromTarget(target)
      if (derived) return derived
    }
  } catch {
    /* 回退派生路径 */
  }
  return gamePluginsRootDir(gameName, gameDir)
}

/**
 * 自底向上删除空目录链（best-effort，仅删空目录）：
 * 卸载后清掉插件库中 <plugin-library>/<gameRoot>/ 空壳，止步于 plugin-library 根本身。
 */
export function pruneEmptyDirsUpTo(dir: string, stopAt: string): void {
  let cur = dir
  for (let i = 0; i < 8; i++) {
    if (!existsSync(cur)) return
    if (cur.toLowerCase() === stopAt.toLowerCase()) return
    let entries: string[] = []
    try {
      entries = readdirSync(cur)
    } catch {
      return
    }
    if (entries.length > 0) return
    try {
      rmSync(cur, { recursive: true })
    } catch {
      return
    }
    const parent = dirname(cur)
    if (parent === cur) return
    cur = parent
  }
}

/** 插件库根目录转发（IPC 层清理空目录时用） */
export function libraryRoot(): string {
  return pluginsRootDir()
}

/**
 * 隔离模式卸载后清理：若该游戏在插件库中的档案目录已清空，
 * 删除 <plugin-library>/<gameRoot>/ 空壳（best-effort，止步于 plugin-library 根）。
 */
export function pruneGameLibrary(gameDir: string, gameName: string): void {
  const libRoot = pluginsRootDir()
  if (!existsSync(libRoot)) return
  const gameLibRoot = resolveGameLibRoot(gameDir, gameName)
  if (!gameLibRoot.toLowerCase().startsWith(libRoot.toLowerCase())) return
  pruneEmptyDirsUpTo(gameLibRoot, libRoot)
}
