import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  GameEntry,
  GameScanResult,
  BepInExRelease,
  LogReadResult,
  IsolatedProfileInfo,
  LibraryAddResult,
  LibraryScanResult,
  UpdateCheckResult
} from '../shared/types'
import { IPC } from '../shared/types'

const api = {
  /** 发现游戏列表（Steam 库 + 手动） */
  discoverGames: (): Promise<GameEntry[]> => ipcRenderer.invoke(IPC.discoverGames),
  /** 弹窗选择游戏目录并添加 */
  addManualGame: (): Promise<GameEntry | null> => ipcRenderer.invoke(IPC.addManualGame),
  /** 扫描某游戏的插件 */
  scanGame: (gameDir: string): Promise<GameScanResult> => ipcRenderer.invoke(IPC.scanGame, gameDir),
  /** 启用/禁用插件 */
  setPluginEnabled: (gameDir: string, pluginId: string, enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.setPluginEnabled, gameDir, pluginId, enabled),
  /** 读取插件 cfg */
  readConfigFile: (cfgPath: string): Promise<string> => ipcRenderer.invoke(IPC.readConfigFile, cfgPath),
  /** 写入插件 cfg */
  writeConfigFile: (cfgPath: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.writeConfigFile, cfgPath, content),

  // ---- 日志 ----
  readLog: (gameDir: string): Promise<LogReadResult> => ipcRenderer.invoke(IPC.logsRead, gameDir),
  tailLog: (gameDir: string): Promise<LogReadResult> => ipcRenderer.invoke(IPC.logsTail, gameDir),
  resetLogOffset: (gameDir: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.logsResetOffset, gameDir),

  // ---- 档案隔离模式（插件库） ----
  isolationMigrate: (gameDir: string, gameName: string, profileName: string): Promise<{ profileId: string; target: string }> =>
    ipcRenderer.invoke(IPC.isolationMigrate, gameDir, gameName, profileName),
  isolationCreate: (gameDir: string, gameName: string, profileName: string): Promise<{ profileId: string; target: string }> =>
    ipcRenderer.invoke(IPC.isolationCreate, gameDir, gameName, profileName),
  isolationSwitch: (gameDir: string, gameName: string, profileId: string): Promise<{ target: string }> =>
    ipcRenderer.invoke(IPC.isolationSwitch, gameDir, gameName, profileId),
  isolationList: (gameDir: string, gameName: string): Promise<IsolatedProfileInfo[]> =>
    ipcRenderer.invoke(IPC.isolationList, gameDir, gameName),
  isolationCurrent: (gameDir: string, gameName: string): Promise<IsolatedProfileInfo | null> =>
    ipcRenderer.invoke(IPC.isolationCurrent, gameDir, gameName),
  isolationRemove: (gameDir: string, gameName: string, profileId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.isolationRemove, gameDir, gameName, profileId),
  /** 在文件管理器中打开目录 */
  openPath: (dir: string): Promise<boolean> => ipcRenderer.invoke(IPC.pluginsRootOpen, dir),

  // ---- 插件库（隔离模式） ----
  /** 扫描游戏插件库（首次自动收集现有档案插件） */
  libraryScan: (gameDir: string, gameName: string): Promise<LibraryScanResult> =>
    ipcRenderer.invoke(IPC.libraryScan, gameDir, gameName),
  /** 添加文件到插件库（.dll / .zip，zip 自动解压条目化） */
  libraryAdd: (gameDir: string, filePaths: string[]): Promise<LibraryAddResult> =>
    ipcRenderer.invoke(IPC.libraryAdd, gameDir, filePaths),
  /** 复制库条目到当前档案 plugins（装入档案，重名覆盖） */
  libraryToProfile: (gameDir: string, gameName: string, relPath: string): Promise<string> =>
    ipcRenderer.invoke(IPC.libraryToProfile, gameDir, gameName, relPath),
  /** 从当前档案移除条目（插件库保留） */
  profileRemoveEntry: (gameDir: string, gameName: string, relPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.profileRemoveEntry, gameDir, gameName, relPath),
  /** 从插件库删除条目（不可恢复；档案副本不受影响） */
  libraryRemove: (gameDir: string, relPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.libraryRemove, gameDir, relPath),
  /** 从拖拽的 File 对象取真实磁盘路径（Electron 37：File.path 已移除，必须用 webUtils） */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // ---- 更新 ----
  /** 检查更新（GitHub Releases，5 分钟缓存） */
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(IPC.updatesCheck),

  // ---- BepInEx 安装 ----
  listBepInExReleases: (runtime: 'mono' | 'il2cpp'): Promise<BepInExRelease[]> =>
    ipcRenderer.invoke(IPC.bepinexListReleases, runtime),
  installBepInEx: (gameDir: string, gameName: string, assetUrl: string, assetName: string): Promise<{ profileId: string; target: string }> =>
    ipcRenderer.invoke(IPC.bepinexInstall, gameDir, gameName, assetUrl, assetName),
  /** 安装进度事件（返回取消订阅函数） */
  onInstallProgress: (
    cb: (p: { phase: string; percent: number; message: string }) => void
  ): (() => void) => {
    const listener = (_e: unknown, p: { phase: string; percent: number; message: string }): void =>
      cb(p)
    ipcRenderer.on('bepinex:install-progress', listener)
    return () => ipcRenderer.removeListener('bepinex:install-progress', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
