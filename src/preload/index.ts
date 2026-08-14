import { contextBridge, ipcRenderer } from 'electron'
import type { GameEntry, GameScanResult, ProfileDef, BepInExRelease } from '../shared/types'
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

  // ---- BepInEx 安装 ----
  listBepInExReleases: (runtime: 'mono' | 'il2cpp'): Promise<BepInExRelease[]> =>
    ipcRenderer.invoke(IPC.bepinexListReleases, runtime),
  installBepInEx: (gameDir: string, assetUrl: string, assetName: string): Promise<string> =>
    ipcRenderer.invoke(IPC.bepinexInstall, gameDir, assetUrl, assetName),
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
