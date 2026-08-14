import { contextBridge, ipcRenderer } from 'electron'
import type {
  GameEntry,
  GameScanResult,
  ProfileDef,
  BepInExRelease,
  LogReadResult,
  IsolatedProfileInfo
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

  // ---- Profile 档案 ----
  listProfiles: (gameDir: string): Promise<ProfileDef[]> =>
    ipcRenderer.invoke(IPC.profilesList, gameDir),
  createProfile: (gameDir: string, name: string, states: Record<string, boolean>): Promise<ProfileDef> =>
    ipcRenderer.invoke(IPC.profilesCreate, gameDir, name, states),
  deleteProfile: (gameDir: string, profileId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.profilesDelete, gameDir, profileId),
  renameProfile: (gameDir: string, profileId: string, name: string): Promise<ProfileDef | null> =>
    ipcRenderer.invoke(IPC.profilesRename, gameDir, profileId, name),
  applyProfile: (gameDir: string, profileId: string): Promise<{ applied: number; rolledBack: number; changes: string[] }> =>
    ipcRenderer.invoke(IPC.profilesApply, gameDir, profileId),

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
  isolationRestore: (gameDir: string, gameName: string, profileId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.isolationRestore, gameDir, gameName, profileId),
  isolationList: (gameDir: string, gameName: string): Promise<IsolatedProfileInfo[]> =>
    ipcRenderer.invoke(IPC.isolationList, gameDir, gameName),
  isolationCurrent: (gameDir: string, gameName: string): Promise<IsolatedProfileInfo | null> =>
    ipcRenderer.invoke(IPC.isolationCurrent, gameDir, gameName),
  /** 在文件管理器中打开目录 */
  openPath: (dir: string): Promise<boolean> => ipcRenderer.invoke(IPC.pluginsRootOpen, dir),

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
