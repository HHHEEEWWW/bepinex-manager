import { contextBridge, ipcRenderer } from 'electron'
import type { GameEntry, GameScanResult } from '../shared/types'
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
    ipcRenderer.invoke(IPC.writeConfigFile, cfgPath, content)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
