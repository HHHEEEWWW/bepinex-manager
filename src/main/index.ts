import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, dirname } from 'path'
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC } from '@shared/types'
import { discoverGames, addManualGame } from './core/games'
import { detectBepInEx } from './core/bepinex'
import { scanPlugins, setPluginEnabled } from './core/plugins'
import {
  scanLibrary,
  addFilesToLibrary,
  copyEntryToProfile,
  removeEntryFromProfile,
  removeLibraryEntry
} from './core/library'
import { listBepInExReleases, installBepInExToLibrary } from './core/installer'
import { checkForUpdates, downloadUpdate, applyUpdate } from './core/updater'
import { searchThunderstore, installThunderstorePackage } from './core/thunderstore'
import type { ThunderstorePackage } from './core/thunderstore'
import { readLog, LogReadResult } from './core/logparser'
import {
  migrateToIsolated,
  createIsolatedProfile,
  switchIsolatedProfile,
  listIsolatedProfiles,
  currentIsolatedProfile,
  removeIsolatedProfile
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

/**
 * 数据根目录解析（管理器的全部数据集中存放，不散落）：
 *   1. 环境变量 BEPINEX_MANAGER_DATA_DIR 显式指定（测试/高级用户）
 *   2. 打包发布版：安装目录内 <exe 所在目录>/data（随安装目录走，便携）
 *   3. 开发模式：%APPDATA%/bepinex-manager
 *
 * 注意：app.getPath('userData') 默认就是 %APPDATA%/<appName>=bepinex-manager，
 * 不要再拼接一层（否则变成 .../bepinex-manager/bepinex-manager，插件库全部定位失败）。
 */
function resolveDataRoot(): string {
  if (process.env.BEPINEX_MANAGER_DATA_DIR) {
    return process.env.BEPINEX_MANAGER_DATA_DIR
  }
  if (app.isPackaged) {
    return join(dirname(app.getPath('exe')), 'data')
  }
  return app.getPath('userData')
}

// 数据根必须在 app ready 之前确定并注入：
// 1. core 层（profiles.ts / isolation.ts / installer.ts）读取 BEPINEX_MANAGER_DATA_DIR
// 2. userData 指向 <dataRoot>/.userdata —— Chromium 缓存（Cache/GPUCache 等）也进安装目录，
//    打包版做到"零 C 盘写入"；注意与 installer 下载缓存（dataRoot/cache）分开，互不污染
const dataRoot = resolveDataRoot()
process.env.BEPINEX_MANAGER_DATA_DIR = dataRoot
app.setPath('userData', join(dataRoot, '.userdata'))

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.bepinexmanager.app')

  try {
    mkdirSync(dataRoot, { recursive: true })
  } catch {
    /* 目录创建失败由具体功能报错 */
  }

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

  // ---- 档案隔离模式（插件库） ----
  ipcMain.handle(IPC.isolationMigrate, (_e, gameDir: string, gameName: string, profileName: string) => {
    if (!/^[\w\u4e00-\u9fa5 -]{1,40}$/.test(profileName)) {
      throw new Error('档案名只能包含中文/字母/数字/空格/连字符，长度 1-40')
    }
    return migrateToIsolated(gameDir, gameName, profileName)
  })

  ipcMain.handle(IPC.isolationCreate, (_e, gameDir: string, gameName: string, profileName: string) => {
    if (!/^[\w\u4e00-\u9fa5 -]{1,40}$/.test(profileName)) {
      throw new Error('档案名只能包含中文/字母/数字/空格/连字符，长度 1-40')
    }
    return createIsolatedProfile(gameDir, gameName, profileName)
  })

  ipcMain.handle(IPC.isolationSwitch, (_e, gameDir: string, gameName: string, profileId: string) =>
    switchIsolatedProfile(gameDir, gameName, profileId)
  )

  ipcMain.handle(IPC.isolationList, (_e, gameDir: string, gameName: string) =>
    listIsolatedProfiles(gameDir, gameName)
  )

  ipcMain.handle(IPC.isolationCurrent, (_e, gameDir: string, gameName: string) =>
    currentIsolatedProfile(gameDir, gameName)
  )

  ipcMain.handle(IPC.isolationRemove, (_e, gameDir: string, gameName: string, profileId: string) => {
    removeIsolatedProfile(gameDir, gameName, profileId)
    return true
  })

  // 在系统文件管理器中打开插件库目录
  ipcMain.handle(IPC.pluginsRootOpen, async (_e, dir: string) => {
    const err = await shell.openPath(dir)
    return err === '' ? true : Promise.reject(new Error(err))
  })

  // ---- 插件库（隔离模式，按游戏分类的共享插件池） ----
  ipcMain.handle(IPC.libraryScan, (_e, gameDir: string, gameName: string) =>
    scanLibrary(gameDir, gameName)
  )
  ipcMain.handle(IPC.libraryAdd, (_e, gameDir: string, filePaths: string[]) =>
    addFilesToLibrary(gameDir, filePaths)
  )
  ipcMain.handle(IPC.libraryToProfile, (_e, gameDir: string, gameName: string, relPath: string) =>
    copyEntryToProfile(gameDir, gameName, relPath)
  )
  ipcMain.handle(IPC.profileRemoveEntry, (_e, gameDir: string, gameName: string, relPath: string) =>
    removeEntryFromProfile(gameDir, gameName, relPath)
  )
  ipcMain.handle(IPC.libraryRemove, (_e, gameDir: string, relPath: string) =>
    removeLibraryEntry(gameDir, relPath)
  )

  // 检查更新（GitHub Releases）
  ipcMain.handle(IPC.updatesCheck, () => checkForUpdates())

  // 下载最新版安装包（带进度事件）
  ipcMain.handle(IPC.updatesDownload, (_e, setupUrl: string) =>
    downloadUpdate(setupUrl, (p) => {
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('updates:download-progress', p))
    })
  )

  // 应用更新（静默安装 + 重启）
  ipcMain.handle(IPC.updatesApply, (_e, setupPath: string) => applyUpdate(setupPath))

  // ---- Thunderstore 集成 ----
  ipcMain.handle(IPC.thunderstoreSearch, (_e, query: string) => searchThunderstore(query))
  ipcMain.handle(
    IPC.thunderstoreInstall,
    (_e, gameDir: string, gameName: string, pkg: ThunderstorePackage) =>
      installThunderstorePackage(gameDir, gameName, pkg, (p) => {
        BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('thunderstore:install-progress', p))
      })
  )

  // ---- BepInEx 安装 ----
  ipcMain.handle(IPC.bepinexListReleases, (_e, runtime: 'mono' | 'il2cpp') =>
    listBepInExReleases(runtime)
  )

  ipcMain.handle(
    IPC.bepinexInstall,
    (_e, gameDir: string, gameName: string, assetUrl: string, assetName: string) => {
      // 方案 A：直装插件库（BepInEx 整树在管理器目录，游戏目录只留注入件）
      return installBepInExToLibrary(gameDir, gameName, assetUrl, assetName, (p) => {
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
