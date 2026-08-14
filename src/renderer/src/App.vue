<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { GameEntry, GameScanResult, PluginInfo } from '@shared/types'

const games = ref<GameEntry[]>([])
const selectedGame = ref<GameEntry | null>(null)
const scan = ref<GameScanResult | null>(null)
const loading = ref(false)
const error = ref('')

const configEditor = ref<{ plugin: PluginInfo; content: string; saving: boolean; saveError: string } | null>(
  null
)

onMounted(async () => {
  try {
    games.value = await window.api.discoverGames()
  } catch (e) {
    error.value = `发现游戏失败: ${e}`
  }
})

async function refreshGames(): Promise<void> {
  try {
    games.value = await window.api.discoverGames()
  } catch (e) {
    error.value = `刷新游戏列表失败: ${e}`
  }
}

async function addManualGame(): Promise<void> {
  const g = await window.api.addManualGame()
  if (g) {
    games.value.push(g)
    await selectGame(g)
  }
}

async function selectGame(g: GameEntry): Promise<void> {
  selectedGame.value = g
  loading.value = true
  error.value = ''
  scan.value = null
  try {
    scan.value = await window.api.scanGame(g.gameDir)
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function togglePlugin(p: PluginInfo): Promise<void> {
  if (!selectedGame.value) return
  const target = !p.enabled
  try {
    await window.api.setPluginEnabled(selectedGame.value.gameDir, p.id, target)
    p.enabled = target
  } catch (e) {
    error.value = String(e)
  }
}

/** 检查依赖是否缺失（不在当前全部插件 guid 集合中） */
function missingDeps(p: PluginInfo): string[] {
  if (!scan.value || !p.meta || p.meta.dependencies.length === 0) return []
  const known = new Set(
    scan.value.plugins.filter((x) => x.meta?.guid).map((x) => x.meta!.guid)
  )
  return p.meta.dependencies.filter((d) => !known.has(d))
}

async function openConfig(p: PluginInfo): Promise<void> {
  if (!p.configFile) return
  try {
    const content = await window.api.readConfigFile(p.configFile)
    configEditor.value = { plugin: p, content, saving: false, saveError: '' }
  } catch (e) {
    error.value = `读取配置失败: ${e}`
  }
}

async function saveConfig(): Promise<void> {
  if (!configEditor.value) return
  const ed = configEditor.value
  ed.saving = true
  ed.saveError = ''
  try {
    await window.api.writeConfigFile(ed.plugin.configFile!, ed.content)
    ed.saving = false
  } catch (e) {
    ed.saving = false
    ed.saveError = String(e)
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function displayName(p: PluginInfo): string {
  return p.meta?.name || p.fileName.replace(/\.dll$/i, '')
}
</script>

<template>
  <div class="layout">
    <!-- 左侧：游戏列表 -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <span class="logo">🧩 BepInEx Manager</span>
        <button class="btn btn-sm" title="刷新游戏列表" @click="refreshGames">↻</button>
      </div>
      <div class="game-list">
        <div
          v-for="g in games"
          :key="g.id"
          class="game-item"
          :class="{ active: selectedGame?.id === g.id }"
          @click="selectGame(g)"
        >
          <div class="game-name">{{ g.name }}</div>
          <div class="game-sub">
            <span :class="['badge', g.bepinex ? 'badge-ok' : 'badge-none']">
              {{ g.bepinex ? `BepInEx ${g.bepinex.majorVersion}` : '无 BepInEx' }}
            </span>
            <span class="game-source">{{ g.source === 'steam' ? 'Steam' : '手动' }}</span>
          </div>
        </div>
        <div v-if="games.length === 0" class="empty-tip">未发现游戏</div>
      </div>
      <div class="sidebar-footer">
        <button class="btn btn-primary btn-block" @click="addManualGame">+ 手动添加游戏目录</button>
      </div>
    </aside>

    <!-- 右侧：插件管理 -->
    <main class="content">
      <template v-if="!selectedGame">
        <div class="placeholder">← 选择一个游戏查看插件</div>
      </template>
      <template v-else>
        <header class="content-header">
          <div>
            <div class="game-title">{{ selectedGame.name }}</div>
            <div class="game-detail">
              {{ selectedGame.gameDir }}
              <span v-if="selectedGame.bepinex" class="badge badge-ok">
                BepInEx {{ selectedGame.bepinex.version ?? selectedGame.bepinex.majorVersion }}
                {{ selectedGame.bepinex.isMono ? '(Mono)' : '(IL2CPP)' }}
              </span>
              <span v-if="!selectedGame.bepinex" class="badge badge-warn">未检测到 BepInEx</span>
            </div>
          </div>
        </header>

        <div v-if="error" class="error-bar">{{ error }}</div>
        <div v-if="loading" class="placeholder">扫描中…</div>

        <template v-else-if="scan">
          <div class="plugin-summary">
            共 {{ scan.plugins.length }} 个插件（启用 {{ scan.plugins.filter((p) => p.enabled).length }}）
          </div>
          <div class="plugin-list">
            <div v-for="p in scan.plugins" :key="p.id" class="plugin-row" :class="{ disabled: !p.enabled }">
              <div class="plugin-main">
                <div class="plugin-name">
                  {{ displayName(p) }}
                  <span v-if="p.meta" class="plugin-version">{{ p.meta.version }}</span>
                </div>
                <div class="plugin-meta mono">
                  <span v-if="p.meta">{{ p.meta.guid }}</span>
                  <span v-else class="dim">{{ p.fileName }}</span>
                  <span class="dim">· {{ fmtSize(p.sizeBytes) }}</span>
                  <span v-if="p.metaError" class="badge badge-warn" :title="p.metaError">元数据读取失败</span>
                </div>
                <div v-if="missingDeps(p).length" class="plugin-deps-warn">
                  ⚠ 缺少依赖：{{ missingDeps(p).join(', ') }}
                </div>
                <div v-else-if="p.meta && p.meta.dependencies.length" class="plugin-deps dim">
                  依赖：{{ p.meta.dependencies.join(', ') }}
                </div>
              </div>
              <div class="plugin-actions">
                <button
                  v-if="p.configFile"
                  class="btn btn-sm"
                  title="编辑配置"
                  @click="openConfig(p)"
                >
                  配置
                </button>
                <button
                  class="btn btn-sm"
                  :class="p.enabled ? 'btn-danger' : 'btn-primary'"
                  @click="togglePlugin(p)"
                >
                  {{ p.enabled ? '禁用' : '启用' }}
                </button>
              </div>
            </div>
            <div v-if="scan.plugins.length === 0" class="empty-tip">plugins 目录下没有插件</div>
          </div>
        </template>
      </template>
    </main>
  </div>

  <!-- 配置编辑器弹窗 -->
  <div v-if="configEditor" class="modal-mask" @click.self="configEditor = null">
    <div class="modal">
      <div class="modal-header">
        <span>{{ displayName(configEditor.plugin) }} — 配置</span>
        <button class="btn btn-sm" @click="configEditor = null">✕</button>
      </div>
      <textarea
        v-model="configEditor.content"
        class="cfg-editor mono"
        spellcheck="false"
      ></textarea>
      <div class="modal-footer">
        <span v-if="configEditor.saveError" class="error-text">{{ configEditor.saveError }}</span>
        <span v-else class="dim">修改 BepInEx 配置，游戏重启后生效</span>
        <button class="btn btn-primary" :disabled="configEditor.saving" @click="saveConfig">
          {{ configEditor.saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  height: 100vh;
}

/* 侧栏 */
.sidebar {
  width: 280px;
  flex-shrink: 0;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.logo {
  font-weight: 600;
  font-size: 15px;
}
.game-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.game-item {
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 4px;
}
.game-item:hover {
  background: var(--bg-hover);
}
.game-item.active {
  background: var(--accent-dim);
}
.game-name {
  font-weight: 600;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.game-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-dim);
}
.sidebar-footer {
  padding: 10px;
  border-top: 1px solid var(--border);
}

/* 内容区 */
.content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.content-header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.game-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 4px;
}
.game-detail {
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.plugin-summary {
  padding: 10px 18px 0;
  font-size: 13px;
  color: var(--text-dim);
}
.plugin-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px 18px 18px;
}
.plugin-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  margin-bottom: 8px;
}
.plugin-row.disabled {
  opacity: 0.55;
}
.plugin-name {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.plugin-version {
  font-size: 12px;
  color: var(--accent);
  background: rgba(76, 154, 255, 0.12);
  padding: 1px 8px;
  border-radius: 10px;
}
.plugin-meta {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 4px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.plugin-deps {
  font-size: 12px;
  margin-top: 4px;
}
.plugin-deps-warn {
  font-size: 12px;
  margin-top: 4px;
  color: #e8b04b;
}
.plugin-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

/* 通用 */
.btn {
  border: 1px solid var(--border);
  background: var(--bg-hover);
  color: var(--text);
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
}
.btn:hover {
  border-color: var(--accent);
}
.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}
.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.btn-danger {
  background: transparent;
  border-color: var(--red);
  color: var(--red);
}
.btn-block {
  width: 100%;
}
.badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 10px;
  white-space: nowrap;
}
.badge-ok {
  background: rgba(63, 185, 106, 0.15);
  color: var(--green);
}
.badge-none {
  background: rgba(154, 163, 175, 0.15);
  color: var(--text-dim);
}
.badge-warn {
  background: rgba(232, 176, 75, 0.15);
  color: #e8b04b;
}
.dim {
  color: var(--text-dim);
}
.mono {
  font-family: var(--mono);
}
.placeholder {
  padding: 40px;
  text-align: center;
  color: var(--text-dim);
}
.empty-tip {
  padding: 24px;
  text-align: center;
  color: var(--text-dim);
}
.error-bar {
  margin: 10px 18px 0;
  padding: 8px 12px;
  background: rgba(224, 93, 93, 0.12);
  border: 1px solid var(--red);
  border-radius: 8px;
  color: var(--red);
  font-size: 13px;
}
.error-text {
  color: var(--red);
  font-size: 12px;
}

/* 弹窗 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}
.modal {
  width: min(680px, 90vw);
  height: min(520px, 85vh);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}
.cfg-editor {
  flex: 1;
  background: #121419;
  color: #c8d0da;
  border: none;
  outline: none;
  resize: none;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.5;
  user-select: text;
}
.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}
</style>
