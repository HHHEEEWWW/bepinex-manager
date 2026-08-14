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
  /** 是否支持 BepInEx（Unity / .NET 引擎或已有 Doorstop 注入） */
  compatible: boolean
  /** 检测到的引擎描述（如 'Unity (IL2CPP)'、'Unity (Mono)'、'.NET (XNA?)'），未知为 null */
  engine: string | null
}

/** BepInEx 安装信息 */
export interface BepInExInfo {
  gameDir: string
  /** 检测到的 BepInEx 主版本：5 / 6 / unknown */
  majorVersion: 5 | 6 | 'unknown'
  /** true = Mono 游戏（BepInEx 5）；false = IL2CPP（BepInEx 6） */
  isMono: boolean
  /** BepInEx 数据根目录（常规 = gameDir/BepInEx；隔离模式 = 档案目录） */
  rootDir: string
  /** 是否处于隔离模式（BepInEx 整树在档案目录，游戏目录只有注入件） */
  isIsolated: boolean
  coreDir: string
  pluginsDir: string
  configDir: string
  /** LogOutput.log（隔离模式下在档案目录） */
  logFile: string | null
  /** 从日志提取的版本字符串，如 "5.4.23.2"，取不到为 null */
  version: string | null
}

/** 单个插件（条目粒度：一个 mod = 一个文件或目录，可含多个 dll） */
export interface PluginInfo {
  /** 唯一 id：相对 plugins 目录的顶层条目名（文件或目录名） */
  id: string
  /** 条目名（顶层文件/目录名） */
  fileName: string
  /** 相对 plugins 目录的顶层条目路径 */
  relPath: string
  /** 条目绝对路径（文件或目录） */
  fullPath: string
  /** 条目内主 dll 的绝对路径（元数据/cfg 关联用；无 dll 时为 null） */
  mainDllPath: string | null
  /** 条目总大小（字节） */
  sizeBytes: number
  /** 是否启用（位于 plugins 目录内） */
  enabled: boolean
  /** 元数据（C# 反射解析，失败时为 null） */
  meta: PluginMetadata | null
  /** 是否有同名配置关联（BepInEx/config/<GUID>.cfg），指向 cfg 路径 */
  configFile: string | null
  /** 元数据解析失败的错误信息 */
  metaError: string | null
  /** Mod 说明（内置或用户自定义，可为 null） */
  note: string | null
}

/** 从 dll 程序集特性解析出的插件元数据 */
export interface PluginMetadata {
  guid: string
  name: string
  version: string
  /** BepInDependency 声明的依赖 GUID 列表 */
  dependencies: string[]
}

/** 插件冲突 */
export interface PluginConflict {
  kind: 'duplicate-guid' | 'duplicate-file'
  /** 冲突说明（中文，UI 直接展示） */
  message: string
  /** 涉及的插件 id 列表 */
  pluginIds: string[]
}

/** 游戏扫描结果 */
export interface GameScanResult {
  game: GameEntry
  plugins: PluginInfo[]
  /** 已禁用插件目录（plugins-disabled）是否存在 */
  hasDisabledDir: boolean
  /** 插件间冲突列表 */
  conflicts: PluginConflict[]
}

/** 隔离档案信息（目录用 ASCII id，中文名存元数据） */
export interface IsolatedProfileInfo {
  /** ASCII 目录 id */
  id: string
  /** 显示名（中文） */
  name: string
  createdAt: string
}

/** BepInEx GitHub release 资产 */
export interface BepInExReleaseAsset {
  name: string
  url: string
  size: number
}

/** BepInEx GitHub release */
export interface BepInExRelease {
  tag: string
  prerelease: boolean
  publishedAt: string
  /** 匹配指定游戏类型的可下载资产 */
  assets: BepInExReleaseAsset[]
}

/** 安装进度 */
export interface InstallProgress {
  phase: 'fetch' | 'download' | 'extract' | 'done' | 'error'
  percent: number
  message: string
}

/** Unity 运行时类型（BepInEx 变体选择） */
export type UnityRuntime = 'mono' | 'il2cpp'

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/** 日志条目 */
export interface LogEntry {
  level: LogLevel
  /** 日志来源（插件名 / Unity Log / BepInEx 等） */
  source: string
  /** 消息内容（含合并的堆栈） */
  message: string
  /** 是否为异常堆栈行（属于上一条错误） */
  isStack: boolean
  /** 日志文件中的行号（1 起） */
  line: number
}

/** 日志读取结果 */
export interface LogReadResult {
  /** 日志文件是否存在 */
  exists: boolean
  /** 日志文件路径 */
  path: string | null
  /** 当前条目数 */
  entryCount: number
  /** 本次返回的条目（增量时仅新条目） */
  entries: LogEntry[]
  /** 错误级别条目按来源统计（崩溃定位） */
  errorStats: Array<{ source: string; count: number }>
}

/** 拖拽安装 MOD 的单项结果 */
export interface ModInstallItem {
  /** 来源文件名（dll 或 zip 内的条目名） */
  fileName: string
  /** 是否成功 */
  ok: boolean
  /** 结果描述（成功路径 / 忽略原因 / 失败原因） */
  message: string
}

/** 拖拽安装 MOD 结果汇总 */
export interface ModInstallResult {
  installed: ModInstallItem[]
  ignored: ModInstallItem[]
  failed: ModInstallItem[]
}

/** 插件库条目（一个 mod：文件或目录） */
export interface LibraryEntry {
  /** 条目相对路径（_library 下，顶层文件名或目录名） */
  relPath: string
  /** 显示名（主 dll 元数据名称优先，否则条目名） */
  name: string
  /** 是否为目录条目 */
  isDir: boolean
  /** 条目总大小 */
  sizeBytes: number
  /** 主 dll 元数据（无 dll / 解析失败为 null） */
  meta: PluginMetadata | null
  /** 元数据解析失败原因 */
  metaError: string | null
  /** 主 dll 文件名（cfg 关联用） */
  mainDllName: string | null
  /** 当前档案是否已装入 */
  installed: boolean
}

/** 插件库扫描结果 */
export interface LibraryScanResult {
  /** 库目录绝对路径 */
  libraryDir: string
  entries: LibraryEntry[]
  /** 本次自动收集的现有插件数（首次迁移提示） */
  collected: number
}

/** 插件库添加文件结果 */
export interface LibraryAddResult {
  added: ModInstallItem[]
  updated: ModInstallItem[]
  ignored: ModInstallItem[]
  failed: ModInstallItem[]
}

/** 检查更新结果 */
export interface UpdateCheckResult {
  /** 当前版本（app.getVersion） */
  current: string
  /** 最新版本号（无 v 前缀；查询失败为 null） */
  latest: string | null
  /** 是否有新版本 */
  hasUpdate: boolean
  /** Release 页面地址 */
  url: string | null
  /** Release 说明（body） */
  notes: string | null
  /** 查询失败原因（成功为 null） */
  error: string | null
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
  writeConfigFile: 'config:write',
  /** 列出 BepInEx 可用版本 */
  bepinexListReleases: 'bepinex:list-releases',
  /** 安装 BepInEx */
  bepinexInstall: 'bepinex:install',
  /** 读取游戏日志（offset=0 全量） */
  logsRead: 'logs:read',
  /** 读取日志增量（自上次读取以来） */
  logsTail: 'logs:tail',
  /** 重置日志读取偏移 */
  logsResetOffset: 'logs:reset-offset',
  /** 迁移到档案隔离模式 */
  isolationMigrate: 'isolation:migrate',
  /** 隔离模式下新建档案（复制框架，干净插件/配置） */
  isolationCreate: 'isolation:create',
  /** 切换隔离档案（改 doorstop target） */
  isolationSwitch: 'isolation:switch',
  /** 列出隔离档案 */
  isolationList: 'isolation:list',
  /** 当前生效的隔离档案 */
  isolationCurrent: 'isolation:current',
  /** 删除隔离档案（当前生效档案受保护） */
  isolationRemove: 'isolation:remove',
  /** 在文件管理器中打开插件库目录 */
  pluginsRootOpen: 'plugins-root:open',
  /** 拖拽安装 MOD（dll / zip 直接装入当前档案 plugins） */
  installMods: 'mods:install',
  /** 扫描游戏插件库（首次自动收集现有插件） */
  libraryScan: 'library:scan',
  /** 添加文件到插件库（dll / zip） */
  libraryAdd: 'library:add',
  /** 复制库条目到当前档案 plugins（装入档案） */
  libraryToProfile: 'library:to-profile',
  /** 从当前档案移除条目（插件库保留） */
  profileRemoveEntry: 'profile:remove-entry',
  /** 从插件库删除条目（不可恢复；档案副本不受影响） */
  libraryRemove: 'library:remove',
  /** 检查更新（GitHub Releases） */
  updatesCheck: 'updates:check'
} as const
