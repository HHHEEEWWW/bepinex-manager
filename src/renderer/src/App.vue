<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { createDiscreteApi, darkTheme } from 'naive-ui'
import { parseCfg, serializeCfg, type CfgDocument } from '@shared/cfgparser'
import type {
  GameEntry,
  GameScanResult,
  PluginConflict,
  PluginInfo,
  ProfileDef,
  BepInExRelease,
  LogReadResult,
  IsolatedProfileInfo
} from '@shared/types'

const { message } = createDiscreteApi(['message'], {
  configProviderProps: { theme: darkTheme }
})

const games = ref<GameEntry[]>([])
const selectedGame = ref<GameEntry | null>(null)
const scan = ref<GameScanResult | null>(null)
const loading = ref(false)

// ---- Profile 档案 ----
const profiles = ref<ProfileDef[]>([])
const profileNameInput = ref('')
const applyingProfile = ref(false)

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
const isolateModal = ref<{ show: boolean; name: string; busy: boolean; error: string } | null>(null)

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
  profiles.value = []
  isolatedList.value = []
  isolatedCurrent.value = null
  loading.value = true
  // 无 BepInEx：显示安装引导
  if (!g.bepinex) {
    loading.value = false
    return
  }
  try {
    scan.value = await window.api.scanGame(g.gameDir)
    profiles.value = await window.api.listProfiles(g.gameDir)
    if (g.bepinex.isIsolated) {
      isolatedList.value = await window.api.isolationList(g.gameDir)
      isolatedCurrent.value = await window.api.isolationCurrent(g.gameDir)
    }
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
    await window.api.isolationMigrate(selectedGame.value.gameDir, m.name.trim())
    m.busy = false
    m.show = false
    message.success('已启用档案隔离模式，BepInEx 已迁入档案目录')
    await refreshGames()
  } catch (e) {
    m.busy = false
    m.error = String(e)
  }
}

async function doSwitchIsolated(p: IsolatedProfileInfo): Promise<void> {
  if (!selectedGame.value) return
  try {
    await window.api.isolationSwitch(selectedGame.value.gameDir, p.id)
    message.success(`已切换到档案「${p.name}」，下次启动游戏生效`)
    isolatedCurrent.value = p
    scan.value = await window.api.scanGame(selectedGame.value.gameDir)
  } catch (e) {
    message.error(String(e))
  }
}

async function doRestore(): Promise<void> {
  if (!selectedGame.value || !isolatedCurrent.value) return
  const cur = isolatedCurrent.value
  if (!confirm(`将档案「${cur.name}」还原为常规模式？（BepInEx 复制回游戏目录，档案保留）`)) return
  try {
    await window.api.isolationRestore(selectedGame.value.gameDir, cur.id)
    message.success('已还原到游戏目录')
    await refreshGames()
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

// ---- Profile 操作 ----
async function saveCurrentAsProfile(): Promise<void> {
  if (!selectedGame.value || !scan.value) return
  const name = profileNameInput.value.trim()
  if (!name) {
    message.warning('请输入档案名称')
    return
  }
  const states: Record<string, boolean> = {}
  for (const p of scan.value.plugins) states[p.id] = p.enabled
  try {
    const created = await window.api.createProfile(selectedGame.value.gameDir, name, states)
    profiles.value.push(created)
    profileNameInput.value = ''
    message.success(`已保存档案「${created.name}」`)
  } catch (e) {
    message.error(`保存失败: ${e}`)
  }
}

async function applyProfileState(p: ProfileDef): Promise<void> {
  if (!selectedGame.value) return
  applyingProfile.value = true
  try {
    const result = await window.api.applyProfile(selectedGame.value.gameDir, p.id)
    if (result.rolledBack > 0) {
      message.warning(`应用「${p.name}」：${result.applied} 项变更，回滚 ${result.rolledBack} 项`)
    } else {
      message.success(`已应用「${p.name}」：${result.applied} 项变更`)
    }
    if (selectedGame.value) {
      scan.value = await window.api.scanGame(selectedGame.value.gameDir)
    }
  } catch (e) {
    message.error(`应用失败: ${e}`)
  } finally {
    applyingProfile.value = false
  }
}

async function removeProfile(p: ProfileDef): Promise<void> {
  if (!selectedGame.value) return
  await window.api.deleteProfile(selectedGame.value.gameDir, p.id)
  profiles.value = profiles.value.filter((x) => x.id !== p.id)
  message.info(`已删除「${p.name}」`)
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
    const runtime = selectedGame.value?.bepinex?.isMono ? 'mono' : 'il2cpp'
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
    await window.api.installBepInEx(selectedGame.value.gameDir, asset.url, asset.name)
    installProgress.value = { phase: 'done', percent: 100, message: '安装完成！' }
    message.success('BepInEx 安装完成，首次运行游戏将生成配置目录')
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
            <span v-if="!selectedGame.bepinex" class="pill pill-warn">未检测到 BepInEx</span>
            <button
              v-if="selectedGame.bepinex && !selectedGame.bepinex.isIsolated"
              class="btn-plain"
              title="把 BepInEx 迁入档案目录，支持多档案独立配置与插件组合"
              @click="isolateModal = { show: true, name: '', busy: false, error: '' }"
            >
              📦 启用档案隔离
            </button>
            <button
              v-if="selectedGame.bepinex?.isIsolated"
              class="btn-plain"
              title="把当前档案复制回游戏目录，恢复常规模式"
              @click="doRestore"
            >
              ↩ 还原到游戏目录
            </button>
            <button v-if="selectedGame.bepinex" class="btn-plain" title="查看 BepInEx 运行日志" @click="openLogModal">
              📋 日志
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

        <!-- 扫描中 -->
        <div v-else-if="loading" class="center-box">
          <div class="loading-ring"></div>
          <div class="center-text dim">正在扫描插件…</div>
        </div>

        <!-- 插件管理 -->
        <template v-else-if="scan">
          <!-- 档案栏 -->
          <div class="profile-bar">
            <template v-if="selectedGame.bepinex?.isIsolated">
              <span class="bar-label">🔒 档案</span>
              <template v-if="isolatedList.length">
                <button
                  v-for="p in isolatedList"
                  :key="p.id"
                  class="profile-chip"
                  :class="{ active: isolatedCurrent?.id === p.id }"
                  :title="isolatedCurrent?.id === p.id ? '当前生效档案' : '点击切换（下次启动游戏生效）'"
                  @click="doSwitchIsolated(p)"
                >
                  {{ p.name }}
                </button>
              </template>
              <span v-else class="dim">暂无档案</span>
              <span class="dim iso-tip">隔离模式下每个档案拥有独立的插件与配置</span>
            </template>
            <template v-else>
            <span class="bar-label">📁 档案</span>
            <template v-if="profiles.length">
              <button
                v-for="p in profiles"
                :key="p.id"
                class="profile-chip"
                :disabled="applyingProfile"
                :title="`应用「${p.name}」（${Object.keys(p.pluginStates).length} 个插件状态）`"
                @click="applyProfileState(p)"
              >
                {{ p.name }}
              </button>
              <button
                v-for="p in profiles"
                :key="'x' + p.id"
                class="profile-del"
                title="删除档案"
                @click="removeProfile(p)"
              >
                ✕
              </button>
            </template>
            <span v-else class="dim">暂无档案</span>
            <input
              v-model="profileNameInput"
              class="profile-input"
              placeholder="新档案名称…"
              @keyup.enter="saveCurrentAsProfile"
            />
            <button class="btn-plain" @click="saveCurrentAsProfile">保存当前状态</button>
            </template>
          </div>

          <!-- 插件统计 -->
          <div class="stat-line">
            共 <b>{{ scan.plugins.length }}</b> 个插件
            <span class="stat-dot ok"></span>启用 {{ enabledCount }}
            <span class="stat-dot off"></span>禁用 {{ scan.plugins.length - enabledCount }}
          </div>

          <!-- 插件列表 -->
          <div class="plugin-list">
            <div
              v-for="p in scan.plugins"
              :key="p.id"
              class="plugin-card"
              :class="{ off: !p.enabled }"
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
              <div class="center-text dim">plugins 目录下还没有插件</div>
            </div>
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

  <!-- ============ 档案隔离迁移弹窗 ============ -->
  <div v-if="isolateModal?.show" class="mask" @click.self="isolateModal.show = false">
    <div class="dialog small-dialog">
      <div class="dialog-head">
        <span>📦 启用档案隔离模式</span>
        <button class="icon-btn" @click="isolateModal.show = false">✕</button>
      </div>
      <div class="isolate-body">
        <p class="dim">
          BepInEx 整树将迁移到管理器数据目录，游戏根目录只保留注入件（winhttp.dll 等）。
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
        <span class="dim">迁移不删除任何文件，随时可还原</span>
        <button
          class="btn-primary"
          :disabled="isolateModal.busy || !isolateModal.name.trim()"
          @click="doMigrate"
        >
          {{ isolateModal.busy ? '迁移中…' : '开始迁移' }}
        </button>
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
            <span class="dim">下载官方 release，解压到游戏目录；首次运行游戏生成完整目录</span>
            <button class="btn-primary" :disabled="!selectedRelease" @click="doInstall">
              下载并安装
            </button>
          </div>
        </template>
      </template>
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
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4c9aff, #7a5cff);
  border-radius: 6px;
  transition: width 0.15s ease;
}
</style>
