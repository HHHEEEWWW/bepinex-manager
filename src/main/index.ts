import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, statSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC } from '@shared/types'
import { discoverGames, addManualGame } from './core/games'
import { detectBepInEx } from './core/bepinex'
import { scanPlugins, setPluginEnabled } from './core/plugins'
import { listProfiles, createProfile, deleteProfile, renameProfile, applyProfile } from './core/profiles'
import { listBepInExReleases, installBepInEx, bepinexAlreadyInstalled } from './core/installer'
import { readLog, LogReadResult } from './core/logparser'
import {
  migrateToIsolated,
  switchIsolatedProfile,
  restoreFromIsolated,
  listIsolatedProfiles,
  currentIsolatedProfile
} from './core/isolation'

/** 每个游戏的日志读取偏移缓存（gameDir -> 字节偏移） */
const logOffsets = new Map<string, number>()

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'BepInEx 管理器',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.bepinexmanager.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function registerIpcHandlers(): void {  // 发现游戏（Steam 库 + 手动）
  ipcMain.handle(IPC.discoverGames, () => discoverGames())

  // 手动添加游戏目录（弹目录选择框）
  ipcMain.handle(IPC.addManualGame, async (): Promise<unknown> => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: '选择游戏安装目录（包含 BepInEx 文件夹）',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return addManualGame(result.filePaths[0])
  })

  // 扫描某游戏的插件
  ipcMain.handle(IPC.scanGame, (_e, gameDir: string) => {
    const bepinex = detectBepInEx(gameDir)
    if (!bepinex) throw new Error(`未在 ${gameDir} 检测到 BepInEx 安装`)
    return scanPlugins(bepinex)
  })

  // 启用/禁用插件
  ipcMain.handle(IPC.setPluginEnabled, (_e, gameDir: string, pluginId: string, enabled: boolean) => {
    const bepinex = detectBepInEx(gameDir)
    if (!bepinex) throw new Error(`未在 ${gameDir} 检测到 BepInEx 安装`)
    return setPluginEnabled(bepinex, pluginId, enabled)
  })

  // 读取插件配置文件
  ipcMain.handle(IPC.readConfigFile, (_e, cfgPath: string) => {
    return readFileSync(cfgPath, 'utf8')
  })

  // 写入插件配置文件
  ipcMain.handle(IPC.writeConfigFile, (_e, cfgPath: string, content: string) => {
    writeFileSync(cfgPath, content, 'utf8')
    return true
  })

  // ---- Profile 档案 ----
  ipcMain.handle(IPC.profilesList, (_e, gameDir: string) => listProfiles(gameDir))

  ipcMain.handle(
    IPC.profilesCreate,
    (_e, gameDir: string, name: string, states: Record<string, boolean>) =>
      createProfile(gameDir, name, states)
  )

  ipcMain.handle(IPC.profilesDelete, (_e, gameDir: string, profileId: string) => {
    deleteProfile(gameDir, profileId)
    return true
  })

  ipcMain.handle(IPC.profilesRename, (_e, gameDir: string, profileId: string, name: string) =>
    renameProfile(gameDir, profileId, name)
  )

  ipcMain.handle(IPC.profilesApply, (_e, gameDir: string, profileId: string) => {
    const bepinex = detectBepInEx(gameDir)
    if (!bepinex) throw new Error(`未在 ${gameDir} 检测到 BepInEx 安装`)
    return applyProfile(bepinex, profileId)
  })

  // ---- 日志 ----
  const logGame = (gameDir: string): { bepinex: NonNullable<ReturnType<typeof detectBepInEx>>; key: string } => {
    const bepinex = detectBepInEx(gameDir)
    if (!bepinex) throw new Error(`未在 ${gameDir} 检测到 BepInEx 安装`)
    return { bepinex, key: gameDir.toLowerCase() }
  }

  ipcMain.handle(IPC.logsRead, (_e, gameDir: string): LogReadResult => {
    const { bepinex, key } = logGame(gameDir)
    const result = readLog(bepinex, 0)
    logOffsets.set(key, statSyncSafe(bepinex.logFile))
    return result
  })

  ipcMain.handle(IPC.logsTail, (_e, gameDir: string): LogReadResult => {
    const { bepinex, key } = logGame(gameDir)
    const offset = logOffsets.get(key) ?? 0
    const result = readLog(bepinex, offset)
    logOffsets.set(key, statSyncSafe(bepinex.logFile))
    return result
  })

  ipcMain.handle(IPC.logsResetOffset, (_e, gameDir: string) => {
    logOffsets.delete(gameDir.toLowerCase())
    return true
  })

  // ---- 档案隔离模式 ----
  ipcMain.handle(IPC.isolationMigrate, (_e, gameDir: string, profileName: string) => {
    if (!/^[\w\u4e00-\u9fa5 -]{1,40}$/.test(profileName)) {
      throw new Error('档案名只能包含中文/字母/数字/空格/连字符，长度 1-40')
    }
    return migrateToIsolated(gameDir, profileName)
  })

  ipcMain.handle(IPC.isolationSwitch, (_e, gameDir: string, profileName: string) =>
    switchIsolatedProfile(gameDir, profileName)
  )

  ipcMain.handle(IPC.isolationRestore, (_e, gameDir: string, profileName: string) => {
    restoreFromIsolated(gameDir, profileName)
    return true
  })

  ipcMain.handle(IPC.isolationList, (_e, gameDir: string) => listIsolatedProfiles(gameDir))

  ipcMain.handle(IPC.isolationCurrent, (_e, gameDir: string) => currentIsolatedProfile(gameDir))

  // ---- BepInEx 安装 ----
  ipcMain.handle(IPC.bepinexListReleases, (_e, runtime: 'mono' | 'il2cpp') =>
    listBepInExReleases(runtime)
  )

  ipcMain.handle(
    IPC.bepinexInstall,
    (_e, gameDir: string, assetUrl: string, assetName: string) => {
      if (bepinexAlreadyInstalled(gameDir)) {
        throw new Error('游戏目录已存在 BepInEx，如需覆盖请先手动处理')
      }
      return installBepInEx(gameDir, assetUrl, assetName, (p) => {
        // 进度通过 send 推送到渲染进程
        BrowserWindow.getAllWindows().forEach((w) =>
          w.webContents.send('bepinex:install-progress', p)
        )
      })
    }
  )
}

/** 日志文件当前大小（不存在返回 0），用于记录增量偏移 */
function statSyncSafe(logFile: string | null): number {
  if (!logFile) return 0
  try {
    return statSync(logFile).size
  } catch {
    return 0
  }
}
