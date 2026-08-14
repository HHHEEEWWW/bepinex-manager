import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  GameEntry,
  GameScanResult,
  BepInExRelease,
  LogReadResult,
  IsolatedProfileInfo,
  ModInstallResult
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

  // ---- MOD 拖拽安装 ----
  /** 拖拽安装 MOD（.dll / .zip）到当前档案 plugins 目录 */
  installMods: (gameDir: string, filePaths: string[]): Promise<ModInstallResult> =>
    ipcRenderer.invoke(IPC.installMods, gameDir, filePaths),
  /** 从拖拽的 File 对象取真实磁盘路径（Electron 37：File.path 已移除，必须用 webUtils） */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

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
