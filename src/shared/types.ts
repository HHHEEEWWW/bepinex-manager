/**
 * 主进程 / 渲染进程共享的类型定义与 IPC 通道名
 */

/** 一个被发现的游戏（安装目录 + BepInEx 状态） */
export interface GameEntry {
  /** 稳定唯一 id（目录路径哈希） */
  id: string
  /** 显示名（取 common 目录名 / 用户输入） */
  name: string
  /** 游戏安装目录 */
  gameDir: string
  /** 来源：Steam 库 / 手动添加 / 其他 */
  source: 'steam' | 'manual'
  /** Steam AppID（来自 libraryfolders.vdf 的 appmanifest，可为空） */
  steamAppId?: number
  /** BepInEx 检测结果；null = 未安装 BepInEx */
  bepinex: BepInExInfo | null
}

/** BepInEx 安装信息 */
export interface BepInExInfo {
  gameDir: string
  /** 检测到的 BepInEx 主版本：5 / 6 / unknown */
  majorVersion: 5 | 6 | 'unknown'
  /** true = Mono 游戏（BepInEx 5）；false = IL2CPP（BepInEx 6） */
  isMono: boolean
  coreDir: string
  pluginsDir: string
  configDir: string
  /** BepInEx/LogOutput.log（存在时） */
  logFile: string | null
  /** 从 LogOutput.log 提取的版本字符串，如 "5.4.23.2"，取不到为 null */
  version: string | null
}

/** 单个插件（dll） */
export interface PluginInfo {
  /** 唯一 id：相对 plugins 目录的路径（含文件名） */
  id: string
  /** dll 文件名 */
  fileName: string
  /** 相对 plugins 目录路径（子目录 + 文件名） */
  relPath: string
  /** 绝对路径 */
  fullPath: string
  /** 文件大小（字节） */
  sizeBytes: number
  /** 是否启用（位于 plugins 目录内） */
  enabled: boolean
  /** 元数据（C# 反射解析，失败时为 null） */
  meta: PluginMetadata | null
  /** 是否有同名配置关联（BepInEx/config/<GUID>.cfg），指向 cfg 路径 */
  configFile: string | null
  /** 元数据解析失败的错误信息 */
  metaError: string | null
}

/** 从 dll 程序集特性解析出的插件元数据 */
export interface PluginMetadata {
  guid: string
  name: string
  version: string
  /** BepInDependency 声明的依赖 GUID 列表 */
  dependencies: string[]
}

/** 游戏扫描结果 */
export interface GameScanResult {
  game: GameEntry
  plugins: PluginInfo[]
  /** 已禁用插件目录（plugins-disabled）是否存在 */
  hasDisabledDir: boolean
}

/** IPC 通道常量（主进程 ipcMain.handle 与 preload 共用） */
export const IPC = {
  /** 发现游戏列表 */
  discoverGames: 'games:discover',
  /** 手动添加游戏目录 */
  addManualGame: 'games:add-manual',
  /** 扫描某游戏的插件 */
  scanGame: 'games:scan',
  /** 启用/禁用插件 */
  setPluginEnabled: 'plugins:set-enabled',
  /** 读取插件配置文件（cfg） */
  readConfigFile: 'config:read',
  /** 写入插件配置文件（cfg） */
  writeConfigFile: 'config:write'
} as const
