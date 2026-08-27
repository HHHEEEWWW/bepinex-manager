<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { createDiscreteApi, darkTheme } from 'naive-ui'
import { parseCfg, serializeCfg, type CfgDocument } from '@shared/cfgparser'
import type {
  GameEntry,
  GameScanResult,
  PluginConflict,
  PluginInfo,
  BepInExRelease,
  LogReadResult,
  IsolatedProfileInfo,
  LibraryAddResult,
  LibraryScanResult,
  ModInstallItem,
  UpdateCheckResult,
  ThunderstorePackage
} from '@shared/types'

const { message } = createDiscreteApi(['message'], {
  configProviderProps: { theme: darkTheme }
})

const games = ref<GameEntry[]>([])
const selectedGame = ref<GameEntry | null>(null)
const scan = ref<GameScanResult | null>(null)
const loading = ref(false)

// ---- BepInEx 安装 ----
const showInstallModal = ref(false)
const releases = ref<BepInExRelease[]>([])
const loadingReleases = ref(false)
const selectedRelease = ref<BepInExRelease | null>(null)
const selectedAssetIndex = ref(0)
const installProgress = ref<{ phase: string; percent: number; message: string } | null>(null)
const installBusy = ref(false)

// ---- 配置编辑器 ----
const configEditor = ref<{
  plugin: PluginInfo
  view: 'form' | 'text'
  text: string
  doc: CfgDocument | null
  saving: boolean
} | null>(null)

// ---- 日志面板 ----
const showLogModal = ref(false)
const logData = ref<LogReadResult | null>(null)
const logFilter = ref<'all' | 'error' | 'warn'>('all')
let logTimer: ReturnType<typeof setInterval> | null = null

// ---- 档案隔离模式 ----
const isolatedList = ref<IsolatedProfileInfo[]>([])
const isolatedCurrent = ref<IsolatedProfileInfo | null>(null)
const isolateModal = ref<{
  show: boolean
  mode: 'migrate' | 'create'
  name: string
  busy: boolean
  error: string
} | null>(null)

// ---- MOD 拖拽安装 ----
const libBusy = ref(false)
/** 插件库扫描结果 */
const library = ref<LibraryScanResult | null>(null)
/** 拖拽高亮状态 */
const libDragOver = ref(false)
const profileDragOver = ref(false)
const trashOver = ref(false)
/** 入库/装入结果反馈（弹窗） */
const libFeedback = ref<{ ok: ModInstallItem[]; warn: ModInstallItem[]; bad: ModInstallItem[] } | null>(null)

/** 外部文件拖到插件库：dll 直接入库，zip 自动解压条目化 */
async function onDropToLibrary(e: DragEvent): Promise<void> {
  libDragOver.value = false
  if (!selectedGame.value) return
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (!files.length) return
  const paths: string[] = []
  for (const f of files) {
    try {
      const p = window.api.getPathForFile(f)
      if (p) paths.push(p)
    } catch {
      /* 取不到路径的文件跳过 */
    }
  }
  if (!paths.length) {
    message.warning('无法读取拖入文件的路径')
    return
  }
  libBusy.value = true
  try {
    const res = await window.api.libraryAdd(selectedGame.value.gameDir, paths)
    showLibFeedback(res)
    await refreshLibrary()
  } catch (err) {
    message.error(`入库失败：${(err as Error).message}`)
  } finally {
    libBusy.value = false
  }
}

/** 库条目拖进档案插件区：复制到当前档案 plugins */
async function onDropToProfile(e: DragEvent): Promise<void> {
  profileDragOver.value = false
  if (!selectedGame.value) return
  // 外部文件拖错位置 → 引导去左侧
  if (e.dataTransfer?.files?.length) {
    message.info('外部文件请拖到左侧「插件库」区域入库')
    return
  }
  const relPath = e.dataTransfer?.getData('application/x-bm-lib')
  if (!relPath) return
  await installEntryToProfile(relPath)
}

/** 档案插件拖到删除区：从当前档案移除（插件库保留） */
async function onDropTrash(e: DragEvent): Promise<void> {
  trashOver.value = false
  if (!selectedGame.value) return
  const relPath = e.dataTransfer?.getData('application/x-bm-profile')
  if (!relPath) return
  try {
    await window.api.profileRemoveEntry(selectedGame.value.gameDir, selectedGame.value.name, relPath)
    message.success(`已从档案移除「${relPath}」（插件库保留）`)
    await refreshAll()
  } catch (err) {
    message.error(String(err))
  }
}

/** 拖拽起点：库条目 */
function onDragLibEntry(e: DragEvent, relPath: string): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/x-bm-lib', relPath)
  e.dataTransfer.effectAllowed = 'copy'
}

/** 拖拽起点：档案条目 */
function onDragProfileEntry(e: DragEvent, relPath: string): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/x-bm-profile', relPath)
  e.dataTransfer.effectAllowed = 'move'
}

/** 复制库条目到当前档案（拖拽 + 按钮共用） */
async function installEntryToProfile(relPath: string): Promise<void> {
  if (!selectedGame.value) return
  try {
    await window.api.libraryToProfile(selectedGame.value.gameDir, selectedGame.value.name, relPath)
    message.success(`已装入当前档案：${relPath}`)
    await refreshAll()
  } catch (err) {
    message.error(String(err))
  }
}

/** 从插件库删除条目（确认后不可恢复） */
async function removeLibEntry(relPath: string, name: string): Promise<void> {
  if (!selectedGame.value) return
  if (!confirm(`确定从插件库删除「${name}」？\n该操作不可恢复；已装入档案的副本不受影响。`)) return
  try {
    await window.api.libraryRemove(selectedGame.value.gameDir, relPath)
    message.success(`已从插件库删除「${name}」`)
    await refreshLibrary()
  } catch (err) {
    message.error(String(err))
  }
}

/** 入库结果提示（弹窗 + 摘要） */
function showLibFeedback(res: LibraryAddResult): void {
  libFeedback.value = {
    ok: [...res.added, ...res.updated],
    warn: res.ignored,
    bad: res.failed
  }
  const ok = res.added.length + res.updated.length
  const bad = res.failed.length
  if (ok && !bad) message.success(`已入库 ${ok} 个插件`)
  else if (ok && bad) message.warning(`已入库 ${ok} 个，失败 ${bad} 个`)
  else if (bad) message.error(`入库失败 ${bad} 个`)
  else message.info('没有可入库的插件')
}

/** 刷新档案插件 + 插件库 */
async function refreshAll(): Promise<void> {
  if (!selectedGame.value || !selectedGame.value.bepinex?.isIsolated) return
  try {
    scan.value = await window.api.scanGame(selectedGame.value.gameDir)
    await refreshLibrary()
  } catch (e) {
    message.error(String(e))
  }
}

/** 刷新插件库（含 installed 标记） */
async function refreshLibrary(): Promise<void> {
  if (!selectedGame.value || !selectedGame.value.bepinex?.isIsolated) return
  try {
    const res = await window.api.libraryScan(selectedGame.value.gameDir, selectedGame.value.name)
    if (res.collected > 0 || res.updated > 0) {
      const parts: string[] = []
      if (res.collected > 0) parts.push(`收集 ${res.collected} 个现有插件`)
      if (res.updated > 0) parts.push(`更新 ${res.updated} 个插件（档案版本已同步）`)
      message.info(`插件库已同步：${parts.join('，')}`)
    }
    library.value = res
  } catch (e) {
    message.error(String(e))
  }
}

/** 在文件管理器中打开插件库目录 */
async function openLibraryDir(): Promise<void> {
  if (!library.value) return
  try {
    await window.api.openPath(library.value.libraryDir)
  } catch (e) {
    message.error(String(e))
  }
}

// ---- 检查更新 ----
const checkingUpdate = ref(false)
const updateModal = ref<UpdateCheckResult | null>(null)
const updateDownloading = ref(false)
const updateDownloadPercent = ref(0)
const updateDownloadMsg = ref('')
let updateUnsub: (() => void) | null = null

async function checkUpdate(): Promise<void> {
  checkingUpdate.value = true
  try {
    const res = await window.api.checkForUpdates()
    if (res.error) {
      message.error(`检查更新失败：${res.error}`)
    } else if (res.hasUpdate) {
      updateModal.value = res
    } else {
      message.success(`已是最新版本 v${res.current}`)
    }
  } catch (err) {
    message.error(`检查更新失败：${(err as Error).message}`)
  } finally {
    checkingUpdate.value = false
  }
}

function openUpdateUrl(): void {
  if (updateModal.value?.url) window.open(updateModal.value.url, '_blank')
}

/** 应用内下载安装包（安装版）：下载 → 确认 → 静默安装并重启 */
async function downloadAndUpdate(): Promise<void> {
  const res = updateModal.value
  if (!res || !res.setupUrl) {
    message.error('未获取到安装包下载地址，请前往 GitHub 手动下载')
    openUpdateUrl()
    return
  }
  if (!res.autoUpdatable) {
    message.warning('便携版不支持应用内自动升级，请下载便携包手动解压覆盖')
    openUpdateUrl()
    return
  }
  updateDownloading.value = true
  updateDownloadPercent.value = 0
  updateDownloadMsg.value = '准备下载…'
  updateUnsub?.()
  updateUnsub = window.api.onUpdateProgress((p) => {
    updateDownloadPercent.value = p.percent
    updateDownloadMsg.value = p.message
  })
  try {
    const dl = await window.api.downloadUpdate(res.setupUrl)
    updateDownloadMsg.value = '下载完成，准备安装…'
    updateUnsub?.()
    updateUnsub = null
    // 确认后静默安装（安装器会自动重启应用）
    const ok = await window.api.applyUpdate(dl.setupPath)
    if (ok.ok) {
      updateModal.value = null
      message.success('安装器已启动，应用即将退出并在安装完成后自动重启')
    } else {
      updateDownloading.value = false
      message.error(`自动升级失败：${ok.message}`)
    }
  } catch (err) {
    updateDownloading.value = false
    updateUnsub?.()
    updateUnsub = null
    message.error(`下载更新失败：${(err as Error).message}`)
  }
}

// ---- Thunderstore 搜索/安装 ----
const tsModal = ref(false)
const tsQuery = ref('')
const tsSearching = ref(false)
const tsResults = ref<ThunderstorePackage[]>([])
const tsError = ref('')
const tsInstalling = ref<{ fullName: string; message: string } | null>(null)

async function tsSearch(): Promise<void> {
  const q = tsQuery.value.trim()
  if (!q) return
  tsSearching.value = true
  tsError.value = ''
  tsResults.value = []
  try {
    tsResults.value = await window.api.thunderstoreSearch(q)
    if (!tsResults.value.length) tsError.value = '没有找到匹配的插件，换个关键词试试'
  } catch (err) {
    tsError.value = `搜索失败：${(err as Error).message}`
  } finally {
    tsSearching.value = false
  }
}

async function tsInstall(pkg: ThunderstorePackage): Promise<void> {
  if (!selectedGame.value) return
  tsInstalling.value = { fullName: pkg.fullName, message: '准备安装…' }
  const off = window.api.onThunderstoreProgress((p) => {
    tsInstalling.value = { fullName: pkg.fullName, message: p.message }
  })
  try {
    const res = await window.api.thunderstoreInstall(selectedGame.value.gameDir, selectedGame.value.name, pkg)
    if (res.installed.length) {
      message.success(`已安装 ${res.installed.length} 个插件：${res.installed.join('、')}`)
    }
    if (res.skipped.length) {
      message.warning(`部分条目跳过：${res.skipped.slice(0, 3).join('；')}${res.skipped.length > 3 ? '…' : ''}`)
    }
    await refreshAll()
  } catch (err) {
    message.error(`安装失败：${(err as Error).message}`)
  } finally {
    off()
    tsInstalling.value = null
  }
}

const filteredLogs = computed(() => {
  if (!logData.value) return []
  if (logFilter.value === 'all') return logData.value.entries
  if (logFilter.value === 'error') {
    return logData.value.entries.filter((e) => e.level === 'error' || e.level === 'fatal')
  }
  return logData.value.entries.filter((e) => e.level === 'warn')
})

onMounted(async () => {
  try {
    games.value = await window.api.discoverGames()
    if (games.value.length > 0 && !selectedGame.value) {
      await selectGame(games.value[0])
    }
  } catch (e) {
    message.error(`发现游戏失败: ${e}`)
  }
})

const enabledCount = computed(() => scan.value?.plugins.filter((p) => p.enabled).length ?? 0)

// 侧栏分组：支持 BepInEx 的游戏 + 折叠的其他游戏
const supportedGames = computed(() => games.value.filter((g) => g.compatible))
const unsupportedGames = computed(() => games.value.filter((g) => !g.compatible))
const showUnsupported = ref(false)

async function refreshGames(): Promise<void> {
  try {
    const prevId = selectedGame.value?.id
    games.value = await window.api.discoverGames()
    if (prevId) {
      const g = games.value.find((x) => x.id === prevId)
      if (g) await selectGame(g)
    }
    message.success('游戏列表已刷新')
  } catch (e) {
    message.error(`刷新游戏列表失败: ${e}`)
  }
}

async function addManualGame(): Promise<void> {
  const g = await window.api.addManualGame()
  if (g) {
    games.value.push(g)
    await selectGame(g)
    message.success(`已添加 ${g.name}`)
  }
}

async function selectGame(g: GameEntry): Promise<void> {
  selectedGame.value = g
  scan.value = null
  isolatedList.value = []
  isolatedCurrent.value = null
  loading.value = true
  // 无 BepInEx：显示安装引导
  if (!g.bepinex) {
    loading.value = false
    return
  }
  // 常规安装（BepInEx 在游戏目录）：只显示迁入插件库引导，不做常规模式管理
  if (!g.bepinex.isIsolated) {
    loading.value = false
    return
  }
  try {
    scan.value = await window.api.scanGame(g.gameDir)
    isolatedList.value = await window.api.isolationList(g.gameDir, g.name)
    isolatedCurrent.value = await window.api.isolationCurrent(g.gameDir, g.name)
    await refreshLibrary()
  } catch (e) {
    message.error(String(e))
  } finally {
    loading.value = false
  }
}

// ---- 档案隔离操作 ----
async function doMigrate(): Promise<void> {
  if (!selectedGame.value || !isolateModal.value) return
  const m = isolateModal.value
  m.busy = true
  m.error = ''
  try {
    if (m.mode === 'create') {
      await window.api.isolationCreate(selectedGame.value.gameDir, selectedGame.value.name, m.name.trim())
      message.success(`已创建并切换到档案「${m.name.trim()}」（干净插件/配置）`)
    } else {
      await window.api.isolationMigrate(selectedGame.value.gameDir, selectedGame.value.name, m.name.trim())
      message.success('已迁入插件库，BepInEx 整树已移到管理器目录')
    }
    m.busy = false
    m.show = false
    await refreshGames()
  } catch (e) {
    m.busy = false
    m.error = String(e)
  }
}

async function doSwitchIsolated(p: IsolatedProfileInfo): Promise<void> {
  if (!selectedGame.value) return
  try {
    await window.api.isolationSwitch(selectedGame.value.gameDir, selectedGame.value.name, p.id)
    message.success(`已切换到档案「${p.name}」，下次启动游戏生效`)
    isolatedCurrent.value = p
    await refreshAll()
  } catch (e) {
    message.error(String(e))
  }
}

async function doRemoveIsolated(p: IsolatedProfileInfo): Promise<void> {
  if (!selectedGame.value) return
  const isCurrent = isolatedCurrent.value?.id === p.id
  if (!confirm(`确定删除档案「${p.name}」？\n${isCurrent ? '（当前生效档案不可删除，请先切换或还原）' : '该操作不可恢复，档案目录将被整体删除。'}`)) return
  try {
    await window.api.isolationRemove(selectedGame.value.gameDir, selectedGame.value.name, p.id)
    message.success(`已删除档案「${p.name}」`)
    isolatedList.value = await window.api.isolationList(selectedGame.value.gameDir, selectedGame.value.name)
    isolatedCurrent.value = await window.api.isolationCurrent(selectedGame.value.gameDir, selectedGame.value.name)
  } catch (e) {
    message.error(String(e))
  }
}

/** 在文件管理器中打开插件库目录 */
async function openPluginsRoot(): Promise<void> {
  if (!selectedGame.value?.bepinex) return
  try {
    await window.api.openPath(selectedGame.value.bepinex.rootDir)
  } catch (e) {
    message.error(String(e))
  }
}

async function togglePlugin(p: PluginInfo): Promise<void> {
  if (!selectedGame.value) return
  const target = !p.enabled
  try {
    await window.api.setPluginEnabled(selectedGame.value.gameDir, p.id, target)
    p.enabled = target
    message.success(target ? `已启用 ${displayName(p)}` : `已禁用 ${displayName(p)}`)
  } catch (e) {
    message.error(String(e))
  }
}

/** 检查依赖是否缺失 */
function missingDeps(p: PluginInfo): string[] {
  if (!scan.value || !p.meta || p.meta.dependencies.length === 0) return []
  const known = new Set(scan.value.plugins.filter((x) => x.meta?.guid).map((x) => x.meta!.guid))
  return p.meta.dependencies.filter((d) => !known.has(d))
}

/** 该插件涉及的冲突 */
function conflictsFor(p: PluginInfo): PluginConflict[] {
  if (!scan.value) return []
  return scan.value.conflicts.filter((c) => c.pluginIds.includes(p.id))
}

// ---- 配置编辑 ----
async function openConfig(p: PluginInfo): Promise<void> {
  if (!p.configFile) return
  try {
    const content = await window.api.readConfigFile(p.configFile)
    let doc: CfgDocument | null = null
    try {
      doc = parseCfg(content)
      // 解析失败（空/非标准格式）时回退文本模式
      if (doc.sections.length === 0 && doc.headerLines.length === 0) doc = null
    } catch {
      doc = null
    }
    configEditor.value = {
      plugin: p,
      view: doc ? 'form' : 'text',
      text: content,
      doc,
      saving: false
    }
    if (!doc) message.info('该配置无法表单化（可能为空或格式特殊），已切换到文本模式')
  } catch (e) {
    message.error(`读取配置失败: ${e}`)
  }
}

async function saveConfig(): Promise<void> {
  if (!configEditor.value) return
  const ed = configEditor.value
  ed.saving = true
  try {
    const content = ed.view === 'form' && ed.doc ? serializeCfg(ed.doc) : ed.text
    await window.api.writeConfigFile(ed.plugin.configFile!, content)
    ed.saving = false
    configEditor.value = null
    message.success('配置已保存，游戏重启后生效')
  } catch (e) {
    ed.saving = false
    message.error(`保存失败: ${e}`)
  }
}

// ---- BepInEx 安装 ----
async function openInstallModal(): Promise<void> {
  showInstallModal.value = true
  installProgress.value = null
  installBusy.value = false
  selectedRelease.value = null
  selectedAssetIndex.value = 0
  loadingReleases.value = true
  releases.value = []
  try {
    const game = selectedGame.value
    const isMono = game?.bepinex?.isMono ?? game?.engine?.includes('Mono') ?? false
    const runtime: 'mono' | 'il2cpp' = isMono ? 'mono' : 'il2cpp'
    releases.value = await window.api.listBepInExReleases(runtime)
    if (releases.value.length === 0) {
      message.warning('没有可用版本，请稍后重试')
    }
  } catch (e) {
    message.error(`获取版本列表失败: ${e}`)
  } finally {
    loadingReleases.value = false
  }
}

function pickRelease(r: BepInExRelease): void {
  selectedRelease.value = r
  selectedAssetIndex.value = 0
}

async function doInstall(): Promise<void> {
  if (!selectedGame.value || !selectedRelease.value) return
  const asset = selectedRelease.value.assets[selectedAssetIndex.value]
  if (!asset) return
  installBusy.value = true
  installProgress.value = { phase: 'download', percent: 0, message: '准备中…' }
  const unsubscribe = window.api.onInstallProgress((p) => {
    installProgress.value = p
  })
  try {
    await window.api.installBepInEx(selectedGame.value.gameDir, selectedGame.value.name, asset.url, asset.name)
    installProgress.value = { phase: 'done', percent: 100, message: '安装完成！' }
    message.success('BepInEx 安装完成（隔离模式）✓ 游戏目录已注入 winhttp.dll + dotnet 运行时，BepInEx 整树在插件库档案中，从 Steam 启动游戏即生效')
    installBusy.value = false
    showInstallModal.value = false
    await refreshGames()
  } catch (e) {
    installBusy.value = false
    installProgress.value = null
    message.error(`安装失败: ${e}`)
  } finally {
    unsubscribe()
  }
}

function fmtSize(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ---- BepInEx 卸载 ----
const showUninstallModal = ref(false)
const uninstallPurge = ref(false)
const uninstallBusy = ref(false)

function openUninstallModal(): void {
  if (!selectedGame.value?.bepinex) return
  uninstallPurge.value = false
  uninstallBusy.value = false
  showUninstallModal.value = true
}

/** 执行卸载：默认移入回收站（可还原），勾选后彻底删除 */
async function doUninstall(): Promise<void> {
  if (!selectedGame.value || uninstallBusy.value) return
  uninstallBusy.value = true
  try {
    const res = await window.api.uninstallBepInEx(selectedGame.value.gameDir, selectedGame.value.name, {
      purge: uninstallPurge.value
    })
    showUninstallModal.value = false
    if (res.failed.length > 0) {
      message.warning(
        `已移除 ${res.removed.length} 项，${res.failed.length} 项失败（文件可能被游戏占用）。请关闭游戏后重新执行卸载即可补完。`
      )
    } else if (res.mode === 'purge') {
      message.success('BepInEx 已彻底卸载，游戏已还原为未安装状态')
    } else {
      message.success('BepInEx 已卸载（项目移入了系统回收站，误删可还原），游戏已还原为未安装状态')
    }
    await refreshGames()
  } catch (e) {
    message.error(`卸载失败: ${e}`)
  } finally {
    uninstallBusy.value = false
  }
}


// ---- 日志操作 ----
async function openLogModal(): Promise<void> {
  if (!selectedGame.value) return
  showLogModal.value = true
  await loadLog()
  // 打开期间每 5 秒增量刷新
  if (logTimer) clearInterval(logTimer)
  logTimer = setInterval(async () => {
    if (!selectedGame.value || !showLogModal.value) return
    try {
      const tail = await window.api.tailLog(selectedGame.value.gameDir)
      if (tail.entries.length > 0 && logData.value) {
        logData.value = {
          ...tail,
          entries: [...logData.value.entries, ...tail.entries],
          entryCount: logData.value.entryCount + tail.entries.length,
          errorStats: tail.errorStats.length > 0 ? tail.errorStats : logData.value.errorStats
        }
      }
    } catch {
      /* 游戏目录变化时静默 */
    }
  }, 5000)
}

async function loadLog(): Promise<void> {
  if (!selectedGame.value) return
  try {
    logData.value = await window.api.readLog(selectedGame.value.gameDir)
  } catch (e) {
    message.error(String(e))
  }
}

function closeLogModal(): void {
  showLogModal.value = false
  if (logTimer) {
    clearInterval(logTimer)
    logTimer = null
  }
}

function displayName(p: PluginInfo): string {
  return p.meta?.name || p.fileName.replace(/\.dll$/i, '')
}
</script>

<template>
  <div class="layout">
    <!-- ============ 左侧：游戏列表 ============ -->
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-logo">🧩</div>
        <div class="brand-text">
          <div class="brand-title">BepInEx 管理器</div>
          <div class="brand-sub">插件目录级管理</div>
        </div>
        <button class="icon-btn" title="刷新游戏列表" @click="refreshGames">↻</button>
      </div>

      <div class="game-list">
        <div
          v-for="g in supportedGames"
          :key="g.id"
          class="game-card"
          :class="{ active: selectedGame?.id === g.id }"
          @click="selectGame(g)"
        >
          <div class="game-name">{{ g.name }}</div>
          <div class="game-meta">
            <span v-if="g.bepinex" class="pill pill-ok">BepInEx {{ g.bepinex.majorVersion }}</span>
            <span v-else class="pill pill-off">无 BepInEx</span>
            <span v-if="g.engine" class="pill pill-engine" :title="g.engine">{{ g.engine }}</span>
            <span class="game-source">{{ g.source === 'steam' ? 'Steam' : '手动' }}</span>
          </div>
        </div>

        <!-- 不支持 BepInEx 的游戏（折叠） -->
        <div v-if="unsupportedGames.length" class="unsupported-toggle" @click="showUnsupported = !showUnsupported">
          <span class="unsupported-caret">{{ showUnsupported ? '▾' : '▸' }}</span>
          <span>其他游戏（不支持 BepInEx）{{ unsupportedGames.length }}</span>
        </div>
        <template v-if="showUnsupported">
          <div
            v-for="g in unsupportedGames"
            :key="g.id"
            class="game-card unsupported"
            :class="{ active: selectedGame?.id === g.id }"
            @click="selectGame(g)"
          >
            <div class="game-name">{{ g.name }}</div>
            <div class="game-meta">
              <span class="pill pill-off">不支持</span>
              <span v-if="g.engine" class="pill pill-engine" :title="g.engine">{{ g.engine }}</span>
              <span class="game-source">{{ g.source === 'steam' ? 'Steam' : '手动' }}</span>
            </div>
          </div>
        </template>

        <div v-if="games.length === 0" class="empty-side">未发现游戏</div>
      </div>

      <div class="sidebar-foot">
        <button class="add-btn" @click="addManualGame">＋ 手动添加游戏目录</button>
      </div>
    </aside>

    <!-- ============ 右侧：内容区 ============ -->
    <main class="content">
      <!-- 未选择 -->
      <div v-if="!selectedGame" class="center-box">
        <div class="center-icon">🎮</div>
        <div class="center-text dim">从左侧选择一个游戏</div>
      </div>

      <template v-else>
        <!-- 头部 -->
        <header class="head">
          <div class="head-main">
            <div class="head-title">{{ selectedGame.name }}</div>
            <div class="head-path mono dim">{{ selectedGame.gameDir }}</div>
          </div>
          <div class="head-badges">
            <span v-if="selectedGame.bepinex" class="pill pill-ok">
              BepInEx {{ selectedGame.bepinex.version ?? selectedGame.bepinex.majorVersion }}
              {{ selectedGame.bepinex.isMono ? '· Mono' : '· IL2CPP' }}
            </span>
            <span v-if="selectedGame.bepinex?.isIsolated" class="pill pill-isolated">🔒 档案隔离</span>
            <button
              v-if="selectedGame.bepinex?.isIsolated"
              class="btn-plain"
              title="插件库存储位置（BepInEx 整树在管理器目录，游戏目录只有注入件）"
              @click="openPluginsRoot"
            >
              📂 插件库
            </button>
            <span v-if="!selectedGame.bepinex" class="pill pill-warn">未检测到 BepInEx</span>
            <button
              v-if="selectedGame.bepinex && !selectedGame.bepinex.isIsolated"
              class="btn-plain"
              title="把 BepInEx 迁入插件库目录（管理器只提供隔离模式）"
              @click="isolateModal = { show: true, mode: 'migrate', name: '', busy: false, error: '' }"
            >
              📦 迁入插件库
            </button>
            <button v-if="selectedGame.bepinex" class="btn-plain" title="查看 BepInEx 运行日志" @click="openLogModal">
              📋 日志
            </button>
            <button class="btn-plain" title="从 GitHub 检查新版本" :disabled="checkingUpdate" @click="checkUpdate">
              {{ checkingUpdate ? '⏳ 检查中…' : '🔄 检查更新' }}
            </button>
            <button
              v-if="selectedGame.bepinex?.isIsolated"
              class="btn-plain"
              title="从 Thunderstore 搜索并安装社区插件（自动入库并装入当前档案）"
              @click="tsModal = true"
            >
              🌐 Thunderstore
            </button>
            <button
              v-if="selectedGame.bepinex"
              class="btn-plain uninstall-btn"
              title="卸载 BepInEx：移除注入件与框架数据，游戏还原为未安装状态"
              @click="openUninstallModal"
            >
              🗑 卸载
            </button>
            <button v-if="!selectedGame.bepinex && selectedGame.compatible" class="btn-primary" @click="openInstallModal">
              ⬇ 安装 BepInEx
            </button>
          </div>
        </header>

        <!-- 无 BepInEx 引导 -->
        <div v-if="!selectedGame.bepinex && !loading" class="center-box">
          <div class="center-icon">🪄</div>
          <template v-if="selectedGame.compatible">
            <div class="center-title">该游戏未安装 BepInEx</div>
            <div class="center-text dim">
              BepInEx 是 Unity / XNA 游戏的插件框架，安装后即可扫描管理插件。
            </div>
            <button class="btn-primary big" @click="openInstallModal">⬇ 一键安装 BepInEx</button>
          </template>
          <template v-else>
            <div class="center-title">该游戏不支持 BepInEx</div>
            <div class="center-text dim">
              未检测到 Unity / .NET 引擎特征（原生引擎游戏无法注入 BepInEx）。
            </div>
          </template>
        </div>

        <!-- 常规安装（BepInEx 在游戏目录）：迁入插件库引导 -->
        <div v-else-if="selectedGame.bepinex && !selectedGame.bepinex.isIsolated" class="center-box">
          <div class="center-icon">📦</div>
          <div class="center-title">该游戏为常规安装（BepInEx 在游戏目录）</div>
          <div class="center-text dim">
            管理器只提供隔离模式（插件库）。一键迁入后即可在此管理插件、配置与档案。
          </div>
          <div class="center-actions">
            <button
              class="btn-primary big"
              @click="isolateModal = { show: true, mode: 'migrate', name: '', busy: false, error: '' }"
            >
              📦 迁入插件库
            </button>
            <button class="btn-plain big uninstall-btn" @click="openUninstallModal">🗑 卸载 BepInEx</button>
          </div>
        </div>

        <!-- 扫描中 -->
        <div v-else-if="loading" class="center-box">
          <div class="loading-ring"></div>
          <div class="center-text dim">正在扫描插件…</div>
        </div>

        <!-- 插件管理（仅隔离模式） -->
        <template v-else-if="scan">
          <!-- 档案栏 -->
          <div class="profile-bar">
            <span class="bar-label">🔒 档案</span>
            <template v-if="isolatedList.length">
              <template v-for="p in isolatedList" :key="p.id">
                <button
                  class="profile-chip"
                  :class="{ active: isolatedCurrent?.id === p.id }"
                  :title="isolatedCurrent?.id === p.id ? '当前生效档案' : '点击切换（下次启动游戏生效）'"
                  @click="doSwitchIsolated(p)"
                >
                  {{ p.name }}
                </button>
                <button
                  class="profile-del"
                  :disabled="isolatedCurrent?.id === p.id"
                  :title="isolatedCurrent?.id === p.id ? '当前生效档案不可删除（先切换）' : '删除档案'"
                  @click="doRemoveIsolated(p)"
                >
                  ✕
                </button>
              </template>
            </template>
            <span v-else class="dim">暂无档案</span>
            <button
              class="btn-plain iso-new-btn"
              title="新建档案：从当前档案复制 BepInEx 框架（插件/配置为空），创建后自动切换"
              @click="isolateModal = { show: true, mode: 'create', name: '', busy: false, error: '' }"
            >
              ＋ 新建档案
            </button>
            <span class="dim iso-tip">隔离模式下每个档案拥有独立的插件与配置</span>
          </div>

          <!-- 插件库 + 当前档案：左右分栏 -->
          <div class="split-main">
            <!-- 左栏：插件库（该游戏全部插件，可拖拽） -->
            <section
              class="lib-pane"
              @dragover.prevent="libDragOver = true"
              @dragleave.prevent="libDragOver = false"
              @drop.prevent="onDropToLibrary"
            >
              <div class="pane-head">
                <span class="pane-title">📚 插件库 <b>{{ library?.entries.length ?? 0 }}</b></span>
                <div class="pane-head-right">
                  <button class="btn-plain mini" title="在文件管理器中打开插件库目录" @click="openLibraryDir">
                    📂 打开目录
                  </button>
                </div>
              </div>
              <div class="lib-drop-tip" :class="{ over: libDragOver, busy: libBusy }">
                {{ libBusy ? '⏳ 正在入库…' : '⬇ 拖 .dll / .zip 文件到这里入库（zip 自动解压）' }}
              </div>
              <div v-if="library && library.entries.length" class="lib-grid">
                <div
                  v-for="e in library.entries"
                  :key="e.relPath"
                  class="lib-card"
                  :class="{ installed: e.installed }"
                  draggable="true"
                  :title="`「${e.name}」\n拖到右侧档案插件区 = 装入当前档案\n双击也可装入`"
                  @dragstart="onDragLibEntry($event, e.relPath)"
                  @dblclick="installEntryToProfile(e.relPath)"
                >
                  <div class="lib-card-top">
                    <span class="lib-icon">{{ e.isDir ? '📦' : '🧩' }}</span>
                    <span class="lib-name">{{ e.name }}</span>
                    <span v-if="e.installed" class="pill pill-ok">✓ 已装</span>
                  </div>
                  <div class="lib-card-meta mono dim">
                    {{ e.meta ? e.meta.guid : e.relPath }}
                    <span class="sep">·</span> {{ fmtSize(e.sizeBytes) }}
                  </div>
                  <div class="lib-card-actions">
                    <button
                      v-if="!e.installed"
                      class="btn-plain mini"
                      @click.stop="installEntryToProfile(e.relPath)"
                    >
                      ＋ 装入档案
                    </button>
                    <span v-else class="dim mini">拖到档案区可更新</span>
                    <button
                      class="btn-plain mini lib-del"
                      title="从插件库删除（不可恢复，档案副本不受影响）"
                      @click.stop="removeLibEntry(e.relPath, e.name)"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              </div>
              <div v-else class="lib-empty">
                <div class="center-icon">📭</div>
                <div class="center-text dim">插件库为空：拖入 .dll / .zip 入库，再拖进右侧档案</div>
              </div>
            </section>

            <!-- 右栏：当前档案插件区（接收库条目拖入） -->
            <section
              class="profile-pane"
              @dragover.prevent="profileDragOver = true"
              @dragleave.prevent="profileDragOver = false"
              @drop.prevent="onDropToProfile"
            >
              <div class="pane-head">
                <span class="pane-title">📁 当前档案「{{ isolatedCurrent?.name }}」插件 <b>{{ scan.plugins.length }}</b></span>
                <div class="pane-head-right">
                  <span class="stat-dot ok"></span>{{ enabledCount }} 启用
                  <span class="stat-dot off"></span>{{ scan.plugins.length - enabledCount }} 禁用
                </div>
              </div>
              <div class="profile-drop-tip" :class="{ over: profileDragOver }">
                {{ profileDragOver ? '松手装入当前档案' : '⬇ 拖插件库条目到这里 = 装入当前档案' }}
              </div>

              <div class="plugin-list">
                <div
                  v-for="p in scan.plugins"
                  :key="p.id"
                  class="plugin-card"
                  :class="{ off: !p.enabled }"
                  draggable="true"
                  :title="'拖到下方删除区 = 从当前档案移除（插件库保留）'"
                  @dragstart="onDragProfileEntry($event, p.relPath)"
                >
                  <div class="plugin-left">
                    <div class="plugin-name-row">
                      <span class="plugin-name">{{ displayName(p) }}</span>
                      <span v-if="p.meta" class="ver-tag">{{ p.meta.version }}</span>
                      <span v-if="!p.enabled" class="pill pill-off">已禁用</span>
                      <span v-if="p.metaError" class="pill pill-warn" :title="p.metaError">元数据读取失败</span>
                      <span
                        v-for="c in conflictsFor(p)"
                        :key="c.kind + c.pluginIds.join()"
                        class="pill pill-conflict"
                        :title="c.message"
                      >
                        {{ c.kind === 'duplicate-guid' ? 'GUID 冲突' : '文件冲突' }}
                      </span>
                    </div>
                    <div class="plugin-guid mono dim">
                      {{ p.meta ? p.meta.guid : p.fileName }}
                      <span class="sep">·</span> {{ fmtSize(p.sizeBytes) }}
                    </div>
                    <div v-if="p.note" class="plugin-note" :title="p.note">
                      {{ p.note.split('\n')[0] }}
                    </div>
                    <div v-if="missingDeps(p).length" class="dep-warn">
                      ⚠ 缺少依赖：{{ missingDeps(p).join(', ') }}
                    </div>
                    <div v-else-if="p.meta && p.meta.dependencies.length" class="dep-ok dim">
                      依赖：{{ p.meta.dependencies.join(', ') }}
                    </div>
                  </div>
                  <div class="plugin-right">
                    <button
                      v-if="p.configFile"
                      class="btn-plain"
                      title="编辑配置文件"
                      @click="openConfig(p)"
                    >
                      ⚙ 配置
                    </button>
                    <span
                      v-else-if="p.meta"
                      class="cfg-pending dim"
                      title="配置文件由插件在游戏首次运行时自动生成，运行一次游戏后即可编辑"
                    >
                      配置未生成（运行游戏后出现）
                    </span>
                    <button
                      class="switch-btn"
                      :class="p.enabled ? 'on' : 'off'"
                      @click="togglePlugin(p)"
                    >
                      {{ p.enabled ? '启用中' : '已禁用' }}
                    </button>
                  </div>
                </div>

                <div v-if="scan.plugins.length === 0" class="center-box">
                  <div class="center-icon">📭</div>
                  <div class="center-text dim">当前档案还没有插件：从左侧插件库拖入即可</div>
                </div>
              </div>

              <!-- 删除区 -->
              <div
                class="trash-zone"
                :class="{ over: trashOver }"
                @dragover.prevent="trashOver = true"
                @dragleave.prevent="trashOver = false"
                @drop.prevent="onDropTrash"
              >
                <span class="trash-icon">🗑</span>
                <span>{{ trashOver ? '松手 = 从当前档案移除（插件库保留）' : '拖档案插件到这里 = 从档案移除（插件库保留）' }}</span>
              </div>
            </section>
          </div>
        </template>
      </template>
    </main>
  </div>

  <!-- ============ 配置编辑器弹窗 ============ -->
  <div v-if="configEditor" class="mask" @click.self="configEditor = null">
    <div class="dialog cfg-dialog">
      <div class="dialog-head">
        <span>⚙ {{ displayName(configEditor.plugin) }} — 配置</span>
        <div class="cfg-head-right">
          <button
            v-if="configEditor.doc"
            class="btn-plain"
            @click="configEditor.view = configEditor.view === 'form' ? 'text' : 'form'"
          >
            {{ configEditor.view === 'form' ? '文本模式' : '表单模式' }}
          </button>
          <button class="icon-btn" @click="configEditor = null">✕</button>
        </div>
      </div>

      <!-- 表单视图 -->
      <div v-if="configEditor.view === 'form' && configEditor.doc" class="cfg-form">
        <div v-for="(section, si) in configEditor.doc.sections" :key="si" class="cfg-section">
          <div v-if="section.name" class="cfg-section-title">{{ section.name }}</div>
          <div v-for="(e, ei) in section.entries" :key="ei" class="cfg-entry">
            <div class="cfg-entry-info">
              <div class="cfg-entry-key mono">{{ e.key }}</div>
              <div
                v-for="(c, ci) in e.comments.filter((x) => !x.trim().startsWith('#'))"
                :key="ci"
                class="cfg-entry-comment dim"
              >
                {{ c }}
              </div>
            </div>
            <div class="cfg-entry-control">
              <!-- Boolean -->
              <button
                v-if="e.settingType === 'Boolean'"
                class="mini-switch"
                :class="e.value === 'true' ? 'on' : 'off'"
                @click="e.value = e.value === 'true' ? 'false' : 'true'"
              >
                {{ e.value === 'true' ? '开' : '关' }}
              </button>
              <!-- Enum -->
              <select v-else-if="e.acceptableValues" v-model="e.value" class="cfg-select">
                <option v-for="v in e.acceptableValues" :key="v" :value="v">{{ v }}</option>
              </select>
              <!-- 数值 -->
              <input
                v-else-if="e.settingType === 'Int32' || e.settingType === 'Single'"
                v-model="e.value"
                type="text"
                inputmode="decimal"
                class="cfg-input mono"
              />
              <!-- 字符串/未知 -->
              <input v-else v-model="e.value" type="text" class="cfg-input mono" />
            </div>
          </div>
        </div>
        <div v-if="configEditor.doc.sections.length === 0" class="center-box slim">
          <div class="center-text dim">该配置文件没有可编辑条目</div>
        </div>
      </div>

      <!-- 文本视图 -->
      <textarea
        v-else
        v-model="configEditor.text"
        class="cfg-editor mono"
        spellcheck="false"
      ></textarea>

      <div class="dialog-foot">
        <span class="dim">修改后需重启游戏生效</span>
        <button class="btn-primary" :disabled="configEditor.saving" @click="saveConfig">
          {{ configEditor.saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>

  <!-- ============ 档案隔离迁移/新建弹窗 ============ -->
  <div v-if="isolateModal?.show" class="mask" @click.self="isolateModal.show = false">
    <div class="dialog small-dialog">
      <div class="dialog-head">
        <span>{{ isolateModal.mode === 'create' ? '➕ 新建档案' : '📦 启用档案隔离' }}</span>
        <button class="icon-btn" @click="isolateModal.show = false">✕</button>
      </div>
      <div class="isolate-body">
        <p v-if="isolateModal.mode === 'create'" class="dim">
          从当前档案复制 BepInEx 框架（<b>插件与配置为空</b>），创建后自动切换生效。
          新档案可独立安装插件、独立配置，互不干扰。
        </p>
        <p v-else class="dim">
          BepInEx 整树将迁移到插件库（管理器目录），游戏根目录只保留注入件（winhttp.dll 等）。
          之后可为不同场景创建多个档案，每个档案拥有<b>独立的插件组合与配置</b>，一键切换。
        </p>
        <input
          v-model="isolateModal.name"
          class="profile-input wide"
          placeholder="档案名称（如：单机档）"
          @keyup.enter="doMigrate"
        />
        <span v-if="isolateModal.error" class="error-text">{{ isolateModal.error }}</span>
      </div>
      <div class="dialog-foot">
        <span class="dim">{{ isolateModal.mode === 'create' ? '不复制现有插件与配置' : '迁移不删除任何文件，随时可还原' }}</span>
        <button
          class="btn-primary"
          :disabled="isolateModal.busy || !isolateModal.name.trim()"
          @click="doMigrate"
        >
          {{ isolateModal.busy ? '处理中…' : isolateModal.mode === 'create' ? '创建档案' : '开始迁移' }}
        </button>
      </div>
    </div>
  </div>

  <!-- ============ 插件库操作结果弹窗 ============ -->
  <div v-if="libFeedback" class="mask" @click.self="libFeedback = null">
    <div class="dialog mod-result-dialog">
      <div class="dialog-head">
        <span>📦 插件库操作结果</span>
        <button class="icon-btn" @click="libFeedback = null">✕</button>
      </div>
      <div class="mod-result-body">
        <div v-if="libFeedback.ok.length" class="mod-result-group ok">
          <div class="mod-result-title">✅ 成功 {{ libFeedback.ok.length }} 项</div>
          <div v-for="(it, i) in libFeedback.ok" :key="'i' + i" class="mod-result-row">
            <span class="mono">{{ it.fileName }}</span>
            <span class="dim">→ {{ it.message }}</span>
          </div>
        </div>
        <div v-if="libFeedback.warn.length" class="mod-result-group warn">
          <div class="mod-result-title">⏭ 已跳过 {{ libFeedback.warn.length }} 项</div>
          <div v-for="(it, i) in libFeedback.warn" :key="'g' + i" class="mod-result-row">
            <span class="mono">{{ it.fileName }}</span>
            <span class="dim">· {{ it.message }}</span>
          </div>
        </div>
        <div v-if="libFeedback.bad.length" class="mod-result-group bad">
          <div class="mod-result-title">❌ 失败 {{ libFeedback.bad.length }} 项</div>
          <div v-for="(it, i) in libFeedback.bad" :key="'f' + i" class="mod-result-row">
            <span class="mono">{{ it.fileName }}</span>
            <span class="dim">· {{ it.message }}</span>
          </div>
        </div>
        <div
          v-if="!libFeedback.ok.length && !libFeedback.warn.length && !libFeedback.bad.length"
          class="dim"
        >
          未处理任何文件
        </div>
      </div>
      <div class="dialog-foot">
        <span class="dim">从插件库拖入档案的插件，Steam 启动游戏即生效</span>
        <button class="btn-primary" @click="libFeedback = null">好的</button>
      </div>
    </div>
  </div>

  <!-- ============ 检查更新弹窗 ============ -->
  <div v-if="updateModal" class="mask" @click.self="updateModal = null">
    <div class="dialog update-dialog">
      <div class="dialog-head">
        <span>🔄 发现新版本 v{{ updateModal.latest }}</span>
        <button class="icon-btn" @click="updateModal = null">✕</button>
      </div>
      <div class="update-body">
        <p class="dim">
          当前版本 <b>v{{ updateModal.current }}</b> → 最新版本 <b class="up">v{{ updateModal.latest }}</b>
        </p>
        <div v-if="updateModal.notes" class="update-notes">
          <div class="mod-result-title">更新说明</div>
          <pre class="update-notes-pre">{{ updateModal.notes }}</pre>
        </div>
        <!-- 下载进度 -->
        <div v-if="updateDownloading" class="update-download">
          <div class="progress-bar"><div class="progress-fill" :style="{ width: updateDownloadPercent + '%' }"></div></div>
          <span class="dim mini">{{ updateDownloadMsg }}（{{ updateDownloadPercent }}%）</span>
        </div>
      </div>
      <div class="dialog-foot">
        <span v-if="updateModal.autoUpdatable" class="dim">应用内自动升级：下载安装包后自动静默安装并重启，数据（安装目录 data/）会保留</span>
        <span v-else class="dim">当前为便携版：请下载便携包手动解压覆盖（运行中的数据目录 data/ 保留）</span>
        <button class="btn-plain" @click="openUpdateUrl" :disabled="updateDownloading">GitHub 页面</button>
        <button v-if="updateModal.autoUpdatable" class="btn-primary" @click="downloadAndUpdate" :disabled="updateDownloading">
          {{ updateDownloading ? '⏳ ' + updateDownloadMsg : '⬇ 下载并自动安装' }}
        </button>
      </div>
    </div>
  </div>

  <!-- ============ Thunderstore 搜索弹窗 ============ -->
  <div v-if="tsModal" class="mask" @click.self="tsModal = false">
    <div class="dialog ts-dialog">
      <div class="dialog-head">
        <span>🌐 Thunderstore — 社区插件搜索</span>
        <button class="icon-btn" @click="tsModal = false">✕</button>
      </div>
      <div class="ts-search-row">
        <input
          v-model="tsQuery"
          class="profile-input wide"
          placeholder="搜索插件（如：BepInEx、ModelReplacement…）"
          @keyup.enter="tsSearch"
        />
        <button class="btn-primary" :disabled="tsSearching || !tsQuery.trim()" @click="tsSearch">
          {{ tsSearching ? '⏳ 搜索中…' : '🔍 搜索' }}
        </button>
      </div>
      <div v-if="tsError" class="error-text ts-error">{{ tsError }}</div>
      <div class="ts-list">
        <div v-for="p in tsResults" :key="p.fullName + p.version" class="ts-card">
          <div class="ts-card-top">
            <span class="ts-name">{{ p.fullName }}</span>
            <span class="ver-tag">v{{ p.version }}</span>
            <span v-if="p.community" class="pill pill-engine" :title="'所属社区'">{{ p.community }}</span>
          </div>
          <div class="ts-desc dim" :title="p.description">{{ p.description || '（无描述）' }}</div>
          <div v-if="p.dependencies.length" class="ts-deps dim mono">
            依赖：{{ p.dependencies.join(', ') }}
          </div>
          <div class="ts-card-foot">
            <span class="dim" v-if="tsInstalling?.fullName === p.fullName">⏳ {{ tsInstalling.message }}</span>
            <button
              v-else
              class="btn-plain mini"
              title="下载最新版 → 入库 → 自动装入当前档案"
              @click="tsInstall(p)"
            >
              ⬇ 安装
            </button>
            <a class="dim ts-link" :href="p.packageUrl" target="_blank" rel="noopener">详情 ↗</a>
          </div>
        </div>
        <div v-if="!tsSearching && !tsResults.length && !tsError" class="ts-empty dim">
          输入关键词搜索 Thunderstore 社区插件
        </div>
      </div>
      <div class="dialog-foot">
        <span class="dim">安装 = 下载最新版 → 入插件库 → 自动装入当前档案；依赖需自行安装</span>
        <button class="btn-plain" @click="tsModal = false">关闭</button>
      </div>
    </div>
  </div>

  <!-- ============ 日志弹窗 ============ -->
  <div v-if="showLogModal" class="mask" @click.self="closeLogModal">
    <div class="dialog log-dialog">
      <div class="dialog-head">
        <span>📋 运行日志 — {{ selectedGame?.name }}</span>
        <div class="log-head-right">
          <select v-model="logFilter" class="log-filter">
            <option value="all">全部</option>
            <option value="error">仅错误</option>
            <option value="warn">仅警告</option>
          </select>
          <button class="btn-plain" @click="loadLog">刷新</button>
          <button class="icon-btn" @click="closeLogModal">✕</button>
        </div>
      </div>
      <div v-if="logData?.errorStats.length" class="log-stats">
        <span class="dim">⚠ 崩溃定位（错误最多的来源）：</span>
        <span
          v-for="s in logData.errorStats.slice(0, 5)"
          :key="s.source"
          class="pill pill-conflict"
        >
          {{ s.source }} × {{ s.count }}
        </span>
      </div>
      <div v-if="!logData?.exists" class="center-box slim">
        <div class="center-text dim">日志文件不存在（首次运行游戏后生成）</div>
      </div>
      <div v-else-if="logData.entryCount === 0" class="center-box slim">
        <div class="center-text dim">日志为空</div>
      </div>
      <div v-else class="log-list">
        <div
          v-for="(e, i) in filteredLogs"
          :key="i"
          class="log-line"
          :class="e.level"
        >
          <span class="log-dot" :class="e.level"></span>
          <span class="log-src mono">{{ e.source }}</span>
          <span class="log-msg mono" :class="{ stack: e.isStack }">{{ e.message }}</span>
        </div>
        <div v-if="filteredLogs.length === 0" class="center-box slim">
          <div class="center-text dim">当前过滤条件下没有条目</div>
        </div>
      </div>
    </div>
  </div>

  <!-- ============ BepInEx 安装弹窗 ============ -->  <div v-if="showInstallModal" class="mask" @click.self="showInstallModal = false">
    <div class="dialog install-dialog">
      <div class="dialog-head">
        <span>⬇ 安装 BepInEx — {{ selectedGame?.name }}</span>
        <button class="icon-btn" @click="showInstallModal = false">✕</button>
      </div>

      <div v-if="loadingReleases" class="center-box slim">
        <div class="loading-ring"></div>
        <div class="center-text dim">获取版本列表…</div>
      </div>

      <template v-else>
        <!-- 进度 -->
        <div v-if="installProgress" class="progress-area">
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: installProgress.percent + '%' }"></div>
          </div>
          <div class="dim">{{ installProgress.message }}</div>
        </div>

        <template v-else>
          <div class="release-list">
            <div
              v-for="r in releases"
              :key="r.tag"
              class="release-card"
              :class="{ active: selectedRelease?.tag === r.tag }"
              @click="pickRelease(r)"
            >
              <div class="release-top">
                <span class="release-tag">{{ r.tag }}</span>
                <span v-if="r.prerelease" class="pill pill-warn">预览版</span>
                <span class="release-date dim">{{ r.publishedAt }}</span>
              </div>
              <div v-if="selectedRelease?.tag === r.tag" class="asset-list">
                <label
                  v-for="(a, i) in r.assets"
                  :key="a.name"
                  class="asset-opt"
                  :class="{ checked: selectedAssetIndex === i }"
                >
                  <input
                    type="radio"
                    :checked="selectedAssetIndex === i"
                    @change="selectedAssetIndex = i"
                  />
                  <span class="mono">{{ a.name }}</span>
                  <span class="dim">{{ fmtSize(a.size) }}</span>
                </label>
                <div v-if="r.assets.length === 0" class="dim asset-empty">
                  该版本没有匹配此游戏的安装包
                </div>
              </div>
            </div>
            <div v-if="releases.length === 0" class="center-box slim">
              <div class="center-text dim">暂时拿不到版本列表，请稍后重试</div>
            </div>
          </div>

          <div class="dialog-foot">
            <span class="dim">直装插件库：BepInEx 整树在管理器目录，游戏目录只保留注入件（Steam 直接启动生效）</span>
            <button class="btn-primary" :disabled="!selectedRelease" @click="doInstall">
              下载并安装
            </button>
          </div>
        </template>
      </template>
    </div>
  </div>

  <!-- ============ BepInEx 卸载弹窗 ============ -->
  <div v-if="showUninstallModal" class="mask" @click.self="showUninstallModal = false">
    <div class="dialog small-dialog">
      <div class="dialog-head">
        <span>🗑 卸载 BepInEx — {{ selectedGame?.name }}</span>
        <button class="icon-btn" @click="showUninstallModal = false">✕</button>
      </div>

      <div class="isolate-body">
        <p>将移除以下内容，把游戏还原为<b>未安装 BepInEx</b> 的状态：</p>
        <ul class="uninstall-list">
          <li>注入件：winhttp.dll、doorstop_config.ini、.doorstop_version（游戏目录）</li>
          <li v-if="selectedGame?.bepinex?.isIsolated">
            插件库中该游戏的<b>全部档案</b>（框架 + 已装插件 + 配置）
          </li>
          <li v-else>BepInEx 主目录 <b>{{ selectedGame?.gameDir }}\BepInEx\</b>（框架 + 插件 + 配置）</li>
          <li>随附的 dotnet/ 运行时目录（若存在）</li>
        </ul>
        <label class="uninstall-opt">
          <input v-model="uninstallPurge" type="checkbox" />
          <span>彻底删除（不进回收站，<b class="danger-text">不可恢复</b>）</span>
        </label>
        <p class="dim">默认移入系统回收站，误删可还原。卸载前请先关闭游戏，否则文件被占用会部分失败。</p>
      </div>

      <div class="dialog-foot">
        <span></span>
        <div class="foot-btns">
          <button class="btn-plain" @click="showUninstallModal = false">取消</button>
          <button class="btn-danger" :disabled="uninstallBusy" @click="doUninstall">
            {{ uninstallBusy ? '卸载中…' : uninstallPurge ? '彻底删除' : '卸载（进回收站）' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  height: 100vh;
  background: #14161a;
  color: #e8eaee;
}

.dim {
  color: #8b93a1;
}

/* ============ 侧栏 ============ */
.sidebar {
  width: 292px;
  flex-shrink: 0;
  background: #1a1d23;
  border-right: 1px solid #2a2e37;
  display: flex;
  flex-direction: column;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 14px 12px;
}
.brand-logo {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, #4c9aff, #7a5cff);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 19px;
  box-shadow: 0 4px 14px rgba(90, 100, 255, 0.35);
}
.brand-title {
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.2px;
}
.brand-sub {
  font-size: 11px;
  color: #8b93a1;
  margin-top: 1px;
}
.game-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px 10px;
}
.game-card {
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.game-card:hover {
  background: #22262e;
}
.game-card.active {
  background: rgba(76, 154, 255, 0.13);
  border-color: rgba(76, 154, 255, 0.45);
}
.game-name {
  font-weight: 600;
  font-size: 13.5px;
  margin-bottom: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.game-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}
.game-source {
  font-size: 11px;
  color: #8b93a1;
}
.empty-side {
  padding: 30px 0;
  text-align: center;
  color: #8b93a1;
  font-size: 13px;
}
.sidebar-foot {
  padding: 10px;
  border-top: 1px solid #2a2e37;
}
.add-btn {
  width: 100%;
  padding: 9px;
  border-radius: 8px;
  border: 1px dashed #3a3f4b;
  background: transparent;
  color: #9aa4b2;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.12s ease;
}
.add-btn:hover {
  border-color: #4c9aff;
  color: #4c9aff;
  background: rgba(76, 154, 255, 0.06);
}

/* ============ 徽章 ============ */
.pill {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 20px;
  white-space: nowrap;
  font-weight: 600;
  letter-spacing: 0.2px;
}
.pill-ok {
  color: #4ade80;
  background: rgba(74, 222, 128, 0.12);
  border: 1px solid rgba(74, 222, 128, 0.3);
}
.pill-off {
  color: #8b93a1;
  background: rgba(139, 147, 161, 0.1);
  border: 1px solid rgba(139, 147, 161, 0.25);
}
.pill-warn {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.1);
  border: 1px solid rgba(251, 191, 36, 0.3);
}
.pill-conflict {
  color: #f87171;
  background: rgba(248, 113, 113, 0.1);
  border: 1px solid rgba(248, 113, 113, 0.35);
}
.pill-isolated {
  color: #c084fc;
  background: rgba(192, 132, 252, 0.12);
  border: 1px solid rgba(192, 132, 252, 0.35);
}
.pill-engine {
  color: #7cb3ff;
  background: rgba(76, 154, 255, 0.08);
  border: 1px solid rgba(76, 154, 255, 0.25);
  font-weight: 500;
}

/* 不支持游戏折叠组 */
.unsupported-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  margin-top: 8px;
  border-top: 1px solid #2a2e37;
  color: #8b93a1;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.unsupported-toggle:hover {
  color: #c9d1dc;
}
.unsupported-caret {
  font-size: 10px;
  width: 10px;
}
.game-card.unsupported {
  opacity: 0.6;
}
.game-card.unsupported:hover {
  opacity: 0.9;
}

/* ============ 内容区 ============ */
.content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 22px 14px;
  border-bottom: 1px solid #242831;
}
.head-title {
  font-size: 19px;
  font-weight: 700;
}
.head-path {
  font-size: 11.5px;
  margin-top: 4px;
  user-select: text;
}
.head-badges {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

/* 档案栏 */
.profile-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 22px;
  border-bottom: 1px solid #242831;
  font-size: 13px;
}
.bar-label {
  font-weight: 700;
  font-size: 12.5px;
  color: #c6ccd6;
}
.profile-chip {
  border: 1px solid #343a46;
  background: #1e222a;
  color: #c9d1dc;
  border-radius: 16px;
  padding: 4px 13px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.12s ease;
}
.profile-chip:hover {
  border-color: #4c9aff;
  color: #4c9aff;
}
.profile-chip:disabled {
  opacity: 0.5;
  cursor: default;
}
.profile-chip.active {
  border-color: #c084fc;
  color: #c084fc;
  background: rgba(192, 132, 252, 0.1);
}
.iso-tip {
  font-size: 12px;
}
.profile-input.wide {
  width: 220px;
}
.profile-del {
  border: none;
  background: transparent;
  color: #6b7280;
  cursor: pointer;
  font-size: 11px;
  padding: 2px;
  margin-left: -4px;
}
.profile-del:hover {
  color: #f87171;
}
.profile-input {
  background: #12151a;
  border: 1px solid #343a46;
  color: #e8eaee;
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 12.5px;
  width: 150px;
  outline: none;
  transition: border-color 0.12s ease;
}
.profile-input:focus {
  border-color: #4c9aff;
}
.profile-input::placeholder {
  color: #5b6472;
}

/* 统计行 */
.stat-line {
  padding: 12px 22px 6px;
  font-size: 12.5px;
  color: #9aa4b2;
  display: flex;
  align-items: center;
  gap: 6px;
}
.stat-line b {
  color: #e8eaee;
}
.stat-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 10px;
}
.stat-dot.ok {
  background: #4ade80;
}
.stat-dot.off {
  background: #6b7280;
}

/* 左右分栏：插件库 + 当前档案 */
.split-main {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 14px;
  padding: 0 22px 18px;
}
.lib-pane,
.profile-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #171b21;
  border: 1px solid #272c35;
  border-radius: 12px;
  overflow: hidden;
}
.pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 14px;
  border-bottom: 1px solid #272c35;
  background: #1b1f26;
}
.pane-title {
  font-weight: 700;
  font-size: 13.5px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pane-head-right {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.btn-plain.mini {
  padding: 2px 8px;
  font-size: 12px;
}
.dim.mini {
  font-size: 11.5px;
}

/* 拖放提示条 */
.lib-drop-tip,
.profile-drop-tip {
  margin: 10px 12px 4px;
  padding: 9px 12px;
  border: 1.5px dashed #3a4250;
  border-radius: 10px;
  font-size: 12.5px;
  text-align: center;
  color: #9aa4b2;
  transition: border-color 0.15s ease, background 0.15s ease;
  flex-shrink: 0;
}
.lib-drop-tip.over,
.profile-drop-tip.over {
  border-color: #4c9aff;
  background: rgba(76, 154, 255, 0.12);
  color: #cfe3ff;
}
.lib-drop-tip.busy {
  opacity: 0.6;
}

/* 插件库卡片网格 */
.lib-grid {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px 14px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
  align-content: start;
}
.lib-card {
  background: #1b1f26;
  border: 1px solid #272c35;
  border-radius: 10px;
  padding: 10px 12px;
  cursor: grab;
  transition: border-color 0.12s ease, transform 0.12s ease, opacity 0.12s ease;
  display: flex;
  flex-direction: column;
  gap: 6px;
  user-select: none;
}
.lib-card:hover {
  border-color: #4c9aff;
  transform: translateY(-1px);
}
.lib-card:active {
  cursor: grabbing;
}
.lib-card.installed {
  border-color: rgba(63, 185, 80, 0.4);
  background: rgba(63, 185, 80, 0.05);
}
.lib-card-top {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.lib-icon {
  font-size: 16px;
  flex-shrink: 0;
}
.lib-name {
  font-weight: 700;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lib-card-meta {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lib-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
}
.lib-del {
  margin-left: auto;
  opacity: 0.55;
}
.lib-del:hover {
  opacity: 1;
  border-color: rgba(224, 49, 49, 0.6);
  color: #ff8080;
}
.lib-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
}

/* 右栏插件列表（现有样式微调） */
.profile-pane .plugin-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
}
.profile-pane .plugin-card {
  cursor: grab;
}
.profile-pane .plugin-card:active {
  cursor: grabbing;
}
.profile-pane .center-box {
  padding: 40px 10px;
}

/* 删除区 */
.trash-zone {
  flex-shrink: 0;
  margin: 4px 12px 12px;
  padding: 10px 12px;
  border: 1.5px dashed #3a4250;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12.5px;
  color: #9aa4b2;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.trash-zone.over {
  border-color: #e03131;
  background: rgba(224, 49, 49, 0.12);
  color: #ffb3b3;
}
.trash-icon {
  font-size: 16px;
}

/* 检查更新弹窗 */
.update-dialog {
  max-width: 560px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
}

/* Thunderstore 搜索弹窗 */
.ts-dialog {
  width: min(720px, 92vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
}
.ts-search-row {
  display: flex;
  gap: 10px;
  padding: 10px 18px 4px;
}
.ts-search-row .profile-input {
  flex: 1;
}
.ts-error {
  padding: 8px 18px 0;
}
.ts-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px 18px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ts-card {
  background: #1b1f26;
  border: 1px solid #272c35;
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ts-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ts-name {
  font-weight: 700;
  font-size: 13.5px;
}
.ts-desc {
  font-size: 12px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ts-deps {
  font-size: 11px;
}
.ts-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.ts-link {
  font-size: 12px;
}
.ts-empty {
  padding: 30px 10px;
  text-align: center;
}
.update-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 18px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
}
.up {
  color: #7cb3ff;
}
.update-notes {
  border: 1px solid #272c35;
  border-radius: 10px;
  background: #1b1f26;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.update-notes-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.6;
  color: #c6ccd6;
  font-family: inherit;
  max-height: 300px;
  overflow-y: auto;
  user-select: text;
}

/* MOD 安装结果弹窗 */
.mod-result-dialog {
  max-height: 70vh;
  display: flex;
  flex-direction: column;
}
.mod-result-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 18px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mod-result-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid;
}
.mod-result-group.ok {
  border-color: rgba(63, 185, 80, 0.35);
  background: rgba(63, 185, 80, 0.07);
}
.mod-result-group.warn {
  border-color: rgba(255, 193, 7, 0.35);
  background: rgba(255, 193, 7, 0.06);
}
.mod-result-group.bad {
  border-color: rgba(224, 49, 49, 0.4);
  background: rgba(224, 49, 49, 0.08);
}
.mod-result-title {
  font-weight: 700;
  font-size: 13px;
}
.mod-result-row {
  font-size: 12px;
  display: flex;
  gap: 8px;
  align-items: baseline;
  word-break: break-all;
}

/* 插件卡片 */
.plugin-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 22px 22px;
}
.plugin-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  background: #1b1f26;
  border: 1px solid #272c35;
  border-radius: 12px;
  padding: 13px 16px;
  margin-bottom: 8px;
  transition: opacity 0.15s ease, border-color 0.12s ease;
}
.plugin-card:hover {
  border-color: #38404d;
}
.plugin-card.off {
  opacity: 0.52;
}
.plugin-left {
  min-width: 0;
}
.plugin-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.plugin-name {
  font-weight: 700;
  font-size: 14px;
}
.ver-tag {
  font-size: 11px;
  color: #7cb3ff;
  background: rgba(76, 154, 255, 0.12);
  padding: 1px 8px;
  border-radius: 10px;
  font-weight: 600;
}
.plugin-guid {
  font-size: 11.5px;
  margin-top: 4px;
  user-select: text;
}
.plugin-note {
  font-size: 12px;
  margin-top: 4px;
  color: #9fb3c8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 640px;
  cursor: help;
}
.sep {
  margin: 0 4px;
  color: #4a5260;
}
.dep-warn {
  font-size: 12px;
  margin-top: 4px;
  color: #fbbf24;
}
.dep-ok {
  font-size: 12px;
  margin-top: 4px;
}
.plugin-right {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
  align-items: center;
}
.cfg-pending {
  font-size: 11.5px;
  max-width: 150px;
  text-align: right;
  line-height: 1.4;
}
.switch-btn {
  min-width: 76px;
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid;
  transition: all 0.12s ease;
}
.switch-btn.on {
  color: #f87171;
  background: transparent;
  border-color: rgba(248, 113, 113, 0.5);
}
.switch-btn.on:hover {
  background: rgba(248, 113, 113, 0.1);
}
.switch-btn.off {
  color: #fff;
  background: #4c9aff;
  border-color: #4c9aff;
}
.switch-btn.off:hover {
  background: #3d86e8;
}

/* 按钮 */
.btn-primary {
  border: none;
  background: linear-gradient(135deg, #4c9aff, #5f7cff);
  color: #fff;
  border-radius: 8px;
  padding: 8px 18px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.12s ease, transform 0.06s ease;
  box-shadow: 0 3px 12px rgba(76, 122, 255, 0.3);
}
.btn-primary:hover {
  filter: brightness(1.1);
}
.btn-primary:active {
  transform: scale(0.98);
}
.btn-primary.big {
  padding: 11px 26px;
  font-size: 14.5px;
}
.btn-primary:disabled {
  opacity: 0.45;
  cursor: default;
}
.btn-plain {
  border: 1px solid #343a46;
  background: transparent;
  color: #c9d1dc;
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 12.5px;
  cursor: pointer;
  transition: all 0.12s ease;
}
.btn-plain:hover {
  border-color: #4c9aff;
  color: #4c9aff;
}

/* 危险操作（卸载） */
.uninstall-btn:hover {
  border-color: #f87171 !important;
  color: #f87171 !important;
}
.btn-danger {
  border: none;
  background: linear-gradient(135deg, #ef4444, #dc2626);
  color: #fff;
  border-radius: 8px;
  padding: 8px 18px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.12s ease, transform 0.06s ease;
  box-shadow: 0 3px 12px rgba(220, 38, 38, 0.3);
}
.btn-danger:hover {
  filter: brightness(1.1);
}
.btn-danger:active {
  transform: scale(0.98);
}
.btn-danger:disabled {
  opacity: 0.45;
  cursor: default;
}
.btn-plain.big {
  padding: 11px 22px;
  font-size: 14px;
}

/* 卸载弹窗 */
.center-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}
.uninstall-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.9;
  color: #c9d1dc;
  word-break: break-all;
}
.uninstall-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  cursor: pointer;
  user-select: none;
  padding: 8px 10px;
  border: 1px dashed #3a3f4b;
  border-radius: 8px;
}
.uninstall-opt input {
  accent-color: #ef4444;
}
.danger-text {
  color: #f87171;
}
.foot-btns {
  display: flex;
  align-items: center;
  gap: 10px;
}
.icon-btn {
  border: none;
  background: transparent;
  color: #8b93a1;
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: all 0.12s ease;
}
.icon-btn:hover {
  color: #e8eaee;
  background: #262b34;
}

/* 居中占位 */
.center-box {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px;
  text-align: center;
}
.center-box.slim {
  padding: 26px;
}
.center-icon {
  font-size: 40px;
}
.center-title {
  font-size: 17px;
  font-weight: 700;
}
.center-text {
  font-size: 13px;
  max-width: 420px;
  line-height: 1.6;
}
.loading-ring {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid #2a2f3a;
  border-top-color: #4c9aff;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ============ 弹窗 ============ */
.mask {
  position: fixed;
  inset: 0;
  background: rgba(8, 10, 14, 0.62);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.dialog {
  background: #1c2027;
  border: 1px solid #2c323c;
  border-radius: 14px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #e8eaee; /* 弹窗内文字显式颜色（防止继承 UA 黑色） */
}
.cfg-dialog {
  width: min(720px, 92vw);
  height: min(560px, 88vh);
}
.log-dialog {
  width: min(860px, 94vw);
  height: min(600px, 90vh);
}
.log-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.log-filter {
  background: #12151a;
  border: 1px solid #343a46;
  color: #e8eaee;
  border-radius: 8px;
  padding: 5px 8px;
  font-size: 12.5px;
  outline: none;
}
.log-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-bottom: 1px solid #2a2f39;
  font-size: 12px;
}
.log-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px;
  font-size: 12px;
  line-height: 1.55;
}
.log-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 6px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
}
.log-line:hover {
  background: rgba(255, 255, 255, 0.03);
}
.log-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  align-self: center;
  transform: translateY(-1px);
}
.log-dot.info {
  background: #4c9aff;
}
.log-dot.debug {
  background: #6b7280;
}
.log-dot.warn {
  background: #fbbf24;
}
.log-dot.error,
.log-dot.fatal {
  background: #f87171;
}
.log-src {
  color: #8b93a1;
  flex-shrink: 0;
  min-width: 110px;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}
.log-msg {
  color: #c9d1dc;
  user-select: text;
}
.log-line.warn .log-msg {
  color: #fbbf24;
}
.log-line.error .log-msg,
.log-line.fatal .log-msg {
  color: #f87171;
}
.log-msg.stack {
  color: #8b93a1;
  padding-left: 14px;
}
.install-dialog {
  width: min(640px, 92vw);
  height: min(560px, 88vh);
}
.small-dialog {
  width: min(460px, 92vw);
}
.isolate-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.isolate-body p {
  font-size: 12.5px;
  line-height: 1.7;
}
.isolate-body b {
  color: #c084fc;
}
.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid #2a2f39;
  font-weight: 700;
  font-size: 14px;
}
.dialog-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-top: 1px solid #2a2f39;
  font-size: 12px;
}
.cfg-editor {
  flex: 1;
  background: #12151a;
  color: #c9d3de;
  border: none;
  outline: none;
  resize: none;
  padding: 14px 16px;
  font-size: 13px;
  line-height: 1.55;
  user-select: text;
}

/* 配置表单视图 */
.cfg-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cfg-form {
  flex: 1;
  overflow-y: auto;
  padding: 10px 16px 16px;
}
.cfg-section {
  margin-bottom: 14px;
}
.cfg-section-title {
  font-weight: 700;
  font-size: 13px;
  color: #7cb3ff;
  padding: 8px 10px;
  margin-bottom: 6px;
  background: rgba(76, 154, 255, 0.07);
  border-left: 3px solid #4c9aff;
  border-radius: 0 6px 6px 0;
}
.cfg-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.cfg-entry:hover {
  background: rgba(255, 255, 255, 0.02);
}
.cfg-entry-info {
  min-width: 0;
  flex: 1;
}
.cfg-entry-key {
  font-size: 12.5px;
  color: #e8eaee;
  word-break: break-all;
}
.cfg-entry-comment {
  font-size: 11.5px;
  margin-top: 2px;
  word-break: break-all;
}
.cfg-entry-control {
  flex-shrink: 0;
}
.mini-switch {
  min-width: 58px;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid;
  transition: all 0.12s ease;
}
.mini-switch.on {
  color: #fff;
  background: #4c9aff;
  border-color: #4c9aff;
}
.mini-switch.off {
  color: #8b93a1;
  background: transparent;
  border-color: #3a3f4b;
}
.cfg-select {
  background: #12151a;
  border: 1px solid #343a46;
  color: #e8eaee;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12.5px;
  outline: none;
  min-width: 150px;
}
.cfg-input {
  background: #12151a;
  border: 1px solid #343a46;
  color: #e8eaee;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12.5px;
  outline: none;
  min-width: 150px;
  transition: border-color 0.12s ease;
}
.cfg-input:focus {
  border-color: #4c9aff;
}

/* 安装弹窗内容 */
.release-list {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.release-card {
  border: 1px solid #2c323c;
  border-radius: 10px;
  padding: 10px 14px;
  cursor: pointer;
  transition: all 0.12s ease;
}
.release-card:hover {
  background: #21262f;
}
.release-card.active {
  border-color: #4c9aff;
  background: rgba(76, 154, 255, 0.07);
}
.release-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.release-tag {
  font-weight: 700;
  font-size: 13.5px;
}
.release-date {
  font-size: 12px;
  margin-left: auto;
}
.asset-list {
  margin-top: 10px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.asset-opt {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12.5px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  transition: background 0.1s ease;
}
.asset-opt:hover {
  background: rgba(255, 255, 255, 0.04);
}
.asset-opt.checked {
  background: rgba(76, 154, 255, 0.12);
}
.asset-empty {
  font-size: 12px;
  padding: 4px 6px;
}
.progress-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
  padding: 0 24px;
  font-size: 13px;
}
.progress-track {
  height: 10px;
  background: #12151a;
  border-radius: 6px;
  overflow: hidden;
}
.progress-bar {
  height: 10px;
  background: #12151a;
  border-radius: 6px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4c9aff, #7a5cff);
  border-radius: 6px;
  transition: width 0.15s ease;
}
.update-download {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
