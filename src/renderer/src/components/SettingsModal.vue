<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { createDiscreteApi, darkTheme } from 'naive-ui'
import type { UpdateCheckResult, ThunderstorePackage, LogReadResult, GameEntry } from '@shared/types'

const { message } = createDiscreteApi(['message'], {
  configProviderProps: { theme: darkTheme }
})

const props = defineProps<{
  game: GameEntry | null
}>()

const emit = defineEmits<{
  close: []
  tsInstall: [pkg: ThunderstorePackage]
}>()

// ---- 通用设置（游戏维度） ----
const autoSaveEnabled = ref(true)
const autoSaveInterval = ref(5)
const restoreSaveBusy = ref(false)

// 使用 localStorage 存储每个游戏的设置，key 为游戏目录哈希
function getGameSettingsKey(gameDir: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < gameDir.length; i++) {
    h ^= gameDir.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'settings_' + (h >>> 0).toString(16)
}

function loadGameSettings(): void {
  if (!props.game) return
  const key = getGameSettingsKey(props.game.gameDir)
  const saved = localStorage.getItem(key)
  if (saved) {
    try {
      const data = JSON.parse(saved)
      autoSaveEnabled.value = data.autoSaveEnabled ?? true
      autoSaveInterval.value = data.autoSaveInterval ?? 5
    } catch {
      // ignore
    }
  } else {
    autoSaveEnabled.value = true
    autoSaveInterval.value = 5
  }
}

function saveGameSettings(): void {
  if (!props.game) return
  const key = getGameSettingsKey(props.game.gameDir)
  localStorage.setItem(key, JSON.stringify({
    autoSaveEnabled: autoSaveEnabled.value,
    autoSaveInterval: autoSaveInterval.value
  }))
}

// 监听游戏切换，加载对应设置
watch(() => props.game?.gameDir, () => {
  loadGameSettings()
}, { immediate: true })

// 监听设置变化，自动保存
watch([autoSaveEnabled, autoSaveInterval], () => {
  saveGameSettings()
})

// ---- 设置分组 ----
type SettingsGroup = 'general' | 'log' | 'update' | 'thunderstore'
const activeGroup = ref<SettingsGroup>('general')

const groups = computed(() => [
  { key: 'general' as SettingsGroup, label: '通用设置', icon: '⚙️' },
  { key: 'log' as SettingsGroup, label: '运行日志', icon: '📋' },
  { key: 'update' as SettingsGroup, label: '检查更新', icon: '🔄' },
  { key: 'thunderstore' as SettingsGroup, label: 'Thunderstore', icon: '🌐' }
])

// ---- 日志相关 ----
const logData = ref<LogReadResult | null>(null)
const logFilter = ref<'all' | 'error' | 'warn'>('all')

// ---- 更新相关 ----
const checkingUpdate = ref(false)
const updateResult = ref<UpdateCheckResult | null>(null)

// ---- Thunderstore 相关 ----
const tsQuery = ref('')
const tsSearching = ref(false)
const tsResults = ref<ThunderstorePackage[]>([])
const tsError = ref('')
const tsInstalling = ref<{ fullName: string; message: string } | null>(null)

// ---- 方法 ----
async function loadLog(): Promise<void> {
  if (!props.game) return
  try {
    logData.value = await window.api.readLog(props.game.gameDir)
  } catch {
    logData.value = null
  }
}

async function checkUpdate(): Promise<void> {
  checkingUpdate.value = true
  updateResult.value = null
  try {
    const res = await window.api.checkForUpdates()
    updateResult.value = res
  } catch {
    message.error('检查更新失败')
  } finally {
    checkingUpdate.value = false
  }
}

async function tsSearch(): Promise<void> {
  const q = tsQuery.value.trim()
  if (!q) return
  tsSearching.value = true
  tsResults.value = []
  tsError.value = ''
  try {
    tsResults.value = await window.api.thunderstoreSearch(q)
    if (!tsResults.value.length) tsError.value = '没有找到匹配的插件，换个关键词试试'
  } catch (err) {
    tsError.value = `搜索失败：${(err as Error).message}`
  } finally {
    tsSearching.value = false
  }
}

async function restoreSave(): Promise<void> {
  if (!props.game) return
  restoreSaveBusy.value = true
  try {
    // TODO: 实现恢复存档的具体逻辑
    message.info('恢复存档功能开发中…')
  } catch (err) {
    message.error(`恢复失败：${(err as Error).message}`)
  } finally {
    restoreSaveBusy.value = false
  }
}

function selectGroup(key: SettingsGroup): void {
  activeGroup.value = key
  if (key === 'log') loadLog()
  if (key === 'update') checkUpdate()
}
</script>

<template>
  <div class="settings-modal" @click.self="emit('close')">
    <div class="settings-container">
      <!-- 左侧导航 -->
      <div class="settings-sidebar">
        <div class="settings-title">设置</div>
        <div class="settings-nav">
          <button
            v-for="g in groups"
            :key="g.key"
            class="nav-item"
            :class="{ active: activeGroup === g.key }"
            @click="selectGroup(g.key)"
          >
            <span class="nav-icon">{{ g.icon }}</span>
            <span class="nav-label">{{ g.label }}</span>
          </button>
        </div>
        <div v-if="game" class="settings-game-info">
          <div class="game-info-label">当前游戏</div>
          <div class="game-info-name">{{ game.name }}</div>
        </div>
      </div>

      <!-- 右侧内容 -->
      <div class="settings-content">
        <!-- 通用设置 -->
        <div v-if="activeGroup === 'general'" class="settings-panel">
          <div class="panel-header">
            <div class="panel-title">通用设置</div>
            <div class="panel-desc">{{ game ? `${game.name} 的配置` : '请先选择一个游戏' }}</div>
          </div>

          <div v-if="!game" class="empty-state">
            <div class="empty-icon">🎮</div>
            <div class="empty-text">请先从左侧选择一个游戏</div>
          </div>

          <template v-else>
            <div class="setting-group">
              <div class="setting-group-title">存档管理</div>

              <div class="setting-item">
                <div class="setting-info">
                  <div class="setting-label">自动备份存档</div>
                  <div class="setting-desc">定期自动备份 {{ game.name }} 的存档文件</div>
                </div>
                <label class="toggle">
                  <input v-model="autoSaveEnabled" type="checkbox" />
                  <span class="toggle-slider"></span>
                </label>
              </div>

              <div v-if="autoSaveEnabled" class="setting-item nested">
                <div class="setting-info">
                  <div class="setting-label">备份间隔</div>
                  <div class="setting-desc">每隔多少分钟自动备份一次</div>
                </div>
                <div class="setting-input">
                  <input
                    v-model.number="autoSaveInterval"
                    type="number"
                    min="1"
                    max="1440"
                    class="number-input"
                  />
                  <span class="input-suffix">分钟</span>
                </div>
              </div>

              <div class="setting-item">
                <div class="setting-info">
                  <div class="setting-label">恢复存档</div>
                  <div class="setting-desc">从历史备份中恢复 {{ game.name }} 的存档</div>
                </div>
                <button
                  class="btn-restore"
                  :disabled="restoreSaveBusy"
                  @click="restoreSave"
                >
                  {{ restoreSaveBusy ? '恢复中…' : '恢复存档' }}
                </button>
              </div>
            </div>

            <div class="setting-group">
              <div class="setting-group-title">游戏信息</div>
              <div class="setting-item">
                <div class="setting-info">
                  <div class="setting-label">游戏目录</div>
                </div>
                <div class="setting-value mono">{{ game.gameDir }}</div>
              </div>
              <div v-if="game.engine" class="setting-item">
                <div class="setting-info">
                  <div class="setting-label">引擎类型</div>
                </div>
                <div class="setting-value">{{ game.engine }}</div>
              </div>
            </div>
          </template>
        </div>

        <!-- 运行日志 -->
        <div v-if="activeGroup === 'log'" class="settings-panel">
          <div class="panel-header">
            <div class="panel-title">运行日志</div>
            <div class="panel-desc">{{ game?.name ?? '未选择游戏' }}</div>
          </div>

          <div v-if="!game" class="empty-state">
            <div class="empty-icon">🎮</div>
            <div class="empty-text">请先从左侧选择一个游戏</div>
          </div>

          <template v-else>
            <div class="log-controls">
              <select v-model="logFilter" class="log-filter">
                <option value="all">全部</option>
                <option value="error">仅错误</option>
                <option value="warn">仅警告</option>
              </select>
              <button class="btn-refresh" @click="loadLog">刷新</button>
            </div>

            <div v-if="!logData?.exists" class="empty-state">
              <div class="empty-icon">📄</div>
              <div class="empty-text">日志文件不存在（首次运行游戏后生成）</div>
            </div>

            <div v-else-if="logData.entryCount === 0" class="empty-state">
              <div class="empty-icon">📝</div>
              <div class="empty-text">日志为空</div>
            </div>

            <div v-else class="log-list">
              <div
                v-for="e in logData.entries"
                :key="e.line"
                class="log-line"
                :class="e.level"
              >
                <span class="log-src">{{ e.source }}</span>
                <span class="log-msg">{{ e.message }}</span>
              </div>
            </div>
          </template>
        </div>

        <!-- 检查更新 -->
        <div v-if="activeGroup === 'update'" class="settings-panel">
          <div class="panel-header">
            <div class="panel-title">检查更新</div>
            <div class="panel-desc">检查 BepInEx Manager 是否有新版本</div>
          </div>

          <div class="update-section">
            <div class="update-status">
              <template v-if="checkingUpdate">
                <div class="status-icon loading">⏳</div>
                <div class="status-text">正在检查更新…</div>
              </template>
              <template v-else-if="updateResult">
                <template v-if="updateResult.hasUpdate">
                  <div class="status-icon available">✅</div>
                  <div class="status-text">
                    发现新版本 <strong>v{{ updateResult.latest }}</strong>
                  </div>
                  <a v-if="updateResult.url" class="btn-download" :href="updateResult.url" target="_blank">
                    前往下载
                  </a>
                </template>
                <template v-else-if="updateResult.error">
                  <div class="status-icon error">❌</div>
                  <div class="status-text">{{ updateResult.error }}</div>
                </template>
                <template v-else>
                  <div class="status-icon ok">✓</div>
                  <div class="status-text">当前已是最新版本 (v{{ updateResult.current }})</div>
                </template>
              </template>
              <template v-else>
                <div class="status-icon">🔍</div>
                <div class="status-text">点击下方按钮检查更新</div>
              </template>
            </div>

            <button class="btn-check" :disabled="checkingUpdate" @click="checkUpdate">
              {{ checkingUpdate ? '检查中…' : '检查更新' }}
            </button>
          </div>
        </div>

        <!-- Thunderstore -->
        <div v-if="activeGroup === 'thunderstore'" class="settings-panel">
          <div class="panel-header">
            <div class="panel-title">Thunderstore</div>
            <div class="panel-desc">搜索并安装社区插件</div>
          </div>

          <div class="ts-search">
            <input
              v-model="tsQuery"
              type="text"
              class="ts-input"
              placeholder="输入插件名称搜索…"
              @keyup.enter="tsSearch"
            />
            <button class="btn-search" :disabled="tsSearching" @click="tsSearch">
              {{ tsSearching ? '搜索中…' : '搜索' }}
            </button>
          </div>

          <div v-if="tsError" class="ts-error">{{ tsError }}</div>

          <div v-if="!tsSearching && !tsResults.length && !tsError" class="empty-state">
            <div class="empty-icon">🌐</div>
            <div class="empty-text">输入关键词搜索 Thunderstore 社区插件</div>
          </div>

          <div v-else class="ts-list">
            <div v-for="pkg in tsResults" :key="pkg.fullName" class="ts-item">
              <div class="ts-item-main">
                <div class="ts-item-name">{{ pkg.name }}</div>
                <div class="ts-item-desc">{{ pkg.description }}</div>
                <div class="ts-item-meta">
                  <span v-if="pkg.version" class="ts-version">v{{ pkg.version }}</span>
                  <span v-if="pkg.community" class="ts-community">{{ pkg.community }}</span>
                </div>
              </div>
              <button
                class="btn-install"
                :disabled="tsInstalling?.fullName === pkg.fullName"
                @click="emit('tsInstall', pkg)"
              >
                {{ tsInstalling?.fullName === pkg.fullName ? tsInstalling.message : '安装' }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 关闭按钮 -->
      <button class="settings-close" @click="emit('close')">✕</button>
    </div>
  </div>
</template>

<style scoped>
.settings-modal {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.settings-container {
  position: relative;
  display: flex;
  width: min(800px, 90vw);
  height: min(560px, 80vh);
  background: #1a1d24;
  border-radius: 16px;
  border: 1px solid #2a2e37;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.settings-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.1);
  color: #9aa4b2;
  font-size: 16px;
  cursor: pointer;
  transition: all 0.15s;
  z-index: 10;
}

.settings-close:hover {
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
}

/* 左侧导航 */
.settings-sidebar {
  width: 180px;
  background: #14161b;
  border-right: 1px solid #2a2e37;
  display: flex;
  flex-direction: column;
}

.settings-title {
  padding: 20px 16px 12px;
  font-size: 14px;
  font-weight: 600;
  color: #e5e9f0;
  letter-spacing: 0.5px;
}

.settings-nav {
  flex: 1;
  padding: 0 8px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #9aa4b2;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  text-align: left;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #e5e9f0;
}

.nav-item.active {
  background: rgba(76, 154, 255, 0.15);
  color: #4c9aff;
}

.nav-icon {
  font-size: 16px;
}

.settings-game-info {
  padding: 12px;
  margin: 8px;
  background: rgba(76, 154, 255, 0.08);
  border-radius: 8px;
  border: 1px solid rgba(76, 154, 255, 0.2);
}

.game-info-label {
  font-size: 11px;
  color: #6b7280;
  margin-bottom: 4px;
}

.game-info-name {
  font-size: 12px;
  color: #e5e9f0;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 右侧内容 */
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.settings-panel {
  max-width: 500px;
}

.panel-header {
  margin-bottom: 24px;
}

.panel-title {
  font-size: 18px;
  font-weight: 600;
  color: #e5e9f0;
  margin-bottom: 4px;
}

.panel-desc {
  font-size: 13px;
  color: #6b7280;
}

/* 设置项 */
.setting-group {
  margin-bottom: 24px;
  background: #1e2128;
  border-radius: 12px;
  padding: 16px;
}

.setting-group-title {
  font-size: 12px;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid #2a2e37;
}

.setting-item:last-child {
  border-bottom: none;
}

.setting-item.nested {
  padding-left: 24px;
}

.setting-info {
  flex: 1;
  margin-right: 16px;
}

.setting-label {
  font-size: 14px;
  color: #e5e9f0;
  margin-bottom: 2px;
}

.setting-desc {
  font-size: 12px;
  color: #6b7280;
}

.setting-value {
  font-size: 13px;
  color: #9aa4b2;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.setting-value.mono {
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 11px;
}

/* 开关 */
.toggle {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex-shrink: 0;
}

.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: #3a3f4b;
  border-radius: 24px;
  transition: 0.2s;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background: #fff;
  border-radius: 50%;
  transition: 0.2s;
}

.toggle input:checked + .toggle-slider {
  background: #4c9aff;
}

.toggle input:checked + .toggle-slider::before {
  transform: translateX(20px);
}

/* 数字输入 */
.setting-input {
  display: flex;
  align-items: center;
  gap: 8px;
}

.number-input {
  width: 70px;
  padding: 6px 10px;
  border: 1px solid #3a3f4b;
  border-radius: 6px;
  background: #14161b;
  color: #e5e9f0;
  font-size: 14px;
  text-align: center;
}

.number-input:focus {
  outline: none;
  border-color: #4c9aff;
}

.input-suffix {
  font-size: 13px;
  color: #6b7280;
}

/* 恢复存档按钮 */
.btn-restore {
  padding: 8px 16px;
  background: transparent;
  border: 1px solid #3a3f4b;
  border-radius: 6px;
  color: #9aa4b2;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-restore:hover:not(:disabled) {
  background: rgba(76, 154, 255, 0.1);
  border-color: #4c9aff;
  color: #4c9aff;
}

.btn-restore:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: #6b7280;
}

.empty-icon {
  font-size: 32px;
  margin-bottom: 12px;
}

.empty-text {
  font-size: 14px;
}

/* 日志 */
.log-controls {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.log-filter {
  padding: 6px 12px;
  border: 1px solid #3a3f4b;
  border-radius: 6px;
  background: #14161b;
  color: #e5e9f0;
  font-size: 13px;
}

.btn-refresh {
  padding: 6px 12px;
  border: 1px solid #3a3f4b;
  border-radius: 6px;
  background: transparent;
  color: #9aa4b2;
  font-size: 13px;
  cursor: pointer;
}

.btn-refresh:hover {
  background: rgba(255, 255, 255, 0.05);
}

.log-list {
  max-height: 350px;
  overflow-y: auto;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
}

.log-line {
  padding: 4px 8px;
  border-radius: 4px;
  display: flex;
  gap: 12px;
}

.log-line.error {
  background: rgba(239, 68, 68, 0.1);
  color: #fca5a5;
}

.log-line.warn {
  background: rgba(251, 191, 36, 0.1);
  color: #fcd34d;
}

.log-src {
  color: #6b7280;
  min-width: 80px;
}

.log-msg {
  flex: 1;
  word-break: break-all;
}

/* 更新 */
.update-section {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.update-status {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: #1e2128;
  border-radius: 12px;
}

.status-icon {
  font-size: 24px;
}

.status-icon.loading {
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.status-text {
  flex: 1;
  font-size: 14px;
  color: #e5e9f0;
}

.btn-download {
  padding: 8px 16px;
  background: #4c9aff;
  color: #fff;
  border-radius: 8px;
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.15s;
}

.btn-download:hover {
  background: #3d8ae6;
}

.btn-check {
  padding: 10px 20px;
  background: #4c9aff;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
  align-self: flex-start;
}

.btn-check:hover:not(:disabled) {
  background: #3d8ae6;
}

.btn-check:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Thunderstore */
.ts-search {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.ts-input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid #3a3f4b;
  border-radius: 8px;
  background: #14161b;
  color: #e5e9f0;
  font-size: 14px;
}

.ts-input:focus {
  outline: none;
  border-color: #4c9aff;
}

.ts-input::placeholder {
  color: #6b7280;
}

.btn-search {
  padding: 10px 20px;
  background: #4c9aff;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-search:hover:not(:disabled) {
  background: #3d8ae6;
}

.btn-search:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ts-error {
  padding: 12px;
  background: rgba(239, 68, 68, 0.1);
  border-radius: 8px;
  color: #fca5a5;
  font-size: 13px;
  margin-bottom: 16px;
}

.ts-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 350px;
  overflow-y: auto;
}

.ts-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: #1e2128;
  border-radius: 8px;
}

.ts-item-main {
  flex: 1;
  min-width: 0;
}

.ts-item-name {
  font-size: 14px;
  font-weight: 500;
  color: #e5e9f0;
  margin-bottom: 4px;
}

.ts-item-desc {
  font-size: 12px;
  color: #6b7280;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ts-item-meta {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.ts-version,
.ts-community {
  font-size: 11px;
  padding: 2px 6px;
  background: rgba(76, 154, 255, 0.1);
  color: #4c9aff;
  border-radius: 4px;
}

.btn-install {
  padding: 8px 16px;
  background: #4c9aff;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
}

.btn-install:hover:not(:disabled) {
  background: #3d8ae6;
}

.btn-install:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
