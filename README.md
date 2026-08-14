# BepInEx Manager

跨游戏通用的 **BepInEx 插件管理器**（Electron + Vue 3 + TypeScript）。

与 r2modman / gale 等"Thunderstore 包管理器"不同，本项目专注 **BepInEx 插件目录级管理**：
直接扫描游戏目录的 `BepInEx/plugins`，解析每个插件的元数据（GUID / 名称 / 版本 / 依赖），支持启用/禁用、配置编辑。

## 功能

- ✅ **游戏发现**：自动扫描 Steam 库（解析 `libraryfolders.vdf` + `appmanifest_*.acf`），支持手动添加游戏目录
- ✅ **BepInEx 检测**：区分 BepInEx 5（Mono）/ 6（IL2CPP），从 LogOutput.log 提取版本号；支持隔离模式自动识别
- ✅ **插件扫描**：递归扫描 `BepInEx/plugins`（含禁用目录），显示名称、GUID、版本、大小
- ✅ **元数据解析**：C# 辅助工具（MetadataLoadContext 只读反射，不执行插件代码）批量提取
  `BepInPlugin` / `BepInDependency` 特性 → GUID、名称、版本、依赖清单
- ✅ **启用/禁用**：dll 在 `plugins` ↔ `plugins-disabled` 之间移动（跨 BepInEx 5/6 兼容，不污染游戏文件）
- ✅ **依赖检查**：自动标出缺失依赖的插件
- ✅ **冲突检测**：GUID 重复（BepInEx 只加载一个）+ 跨目录同名 dll 检测，卡片红色徽章提示
- ✅ **配置编辑**：cfg **结构化表单**（Boolean 开关 / 枚举下拉 / 数值输入，类型从 `# Setting type` 注释推断）+ 文本模式切换
- ✅ **Profile 档案 v1**：保存/应用插件启停状态快照（应用失败自动回滚）
- ✅ **Profile 隔离 v2**：BepInEx 整树迁移到档案目录，doorstop_config.ini 指向档案 preloader，
  从 Steam 直接启动生效，多档案独立插件与配置一键切换，支持还原（Doorstop v3/v4 兼容）
- ✅ **日志解析**：LogOutput.log 增量读取，错误/警告高亮、堆栈合并、按来源统计崩溃定位
- ✅ **BepInEx 一键安装**：从 GitHub 官方 release 下载（BepInEx 5 稳定版 + 6.x pre），按 Mono/IL2CPP
  自动过滤资产，进度条 + 24h 本地缓存 + 网页回退（releases.atom + expanded_assets，不受 API 限流）

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Electron 37 |
| 构建 | electron-vite 4 + Vite 7 |
| UI | Vue 3 + TypeScript |
| 元数据解析 | .NET 9 控制台工具（`tools/plugin-metadata-reader`，System.Reflection.MetadataLoadContext） |

## 目录结构

```
bepinex-manager/
├─ src/
│  ├─ main/               # Electron 主进程
│  │  ├─ index.ts         #   窗口 + IPC 注册
│  │  └─ core/            #   核心逻辑（纯 Node，可独立测试）
│  │     ├─ games.ts      #     Steam 库扫描 / 手动添加
│  │     ├─ bepinex.ts    #     BepInEx 版本检测
│  │     ├─ plugins.ts    #     插件扫描与启停
│  │     └─ metadata.ts   #     调用 C# 工具解析元数据
│  ├─ preload/            # contextBridge 安全桥
│  ├─ renderer/           # Vue 3 UI（游戏列表 + 插件管理 + 配置编辑）
│  └─ shared/types.ts     # 共享类型 + IPC 通道常量
├─ tools/plugin-metadata-reader/   # C# 元数据读取工具（net9.0）
└─ scripts/verify-core.ts          # 核心逻辑独立验证脚本（无 Electron）
```

## 开发

```powershell
# 安装依赖（pnpm 11；electron 二进制下载失败时设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
pnpm install

# 类型检查
pnpm typecheck

# 开发模式（热重载）
pnpm dev

# 生产构建
pnpm build

# 核心逻辑验证（不启动 Electron）
pnpm exec esbuild scripts/verify-core.ts --bundle --platform=node --format=cjs --outfile=scripts/verify-core.cjs --alias:@shared=./src/shared
node scripts/verify-core.cjs
```

## 核心设计说明

### 插件启用/禁用机制

BepInEx 只加载 `BepInEx/plugins/` 下的 dll。本项目将禁用的插件移动到
`BepInEx/plugins-disabled/`（与 plugins 平级，保持相对目录结构），启用时移回。
该方案跨 BepInEx 5/6 兼容，不修改游戏本体文件。

### 元数据解析安全模型

`tools/plugin-metadata-reader` 使用 `MetadataLoadContext` 以**只读**方式加载目标程序集：
只解析元数据表，绝不执行插件代码（不运行模块初始化器、不解析方法体），
可安全处理来自网络的未知 mod 文件。

`BepInPlugin` / `BepInDependency` 特性同时存在于插件类级（BepInEx 5/6 标准写法）与程序集级（老式写法），
工具两者都会扫描。

## 路线图

- [ ] 打包分发（electron-builder NSIS）—— P0-P1 全部完成后的收尾项
- [x] **Profile 隔离模式（v2）**：Doorstop 方案已落地（`src/main/core/isolation.ts`），
      迁移/切换/还原 + 验证脚本 `scripts/verify-isolation.ts`
- [x] 插件文件覆盖/重复冲突检测（GUID + 同名文件）
- [x] LogOutput.log 解析（错误高亮、崩溃定位、增量读取）
- [x] cfg 结构化编辑（`src/shared/cfgparser.ts`，类型推断 + 表单/文本双视图）
- [ ] Thunderstore 搜索/安装集成（生态集成，最后阶段）

## r2modman 调研结论（已落地/待落地）

基于 `.research/r2modmanPlus` 克隆源码的详细调研（3 个子代理 + 主线程阅读）：

| 结论 | 状态 |
|---|---|
| Profile 隔离 = BepInEx 整树进 profile + doorstop_config.ini 指向 profile preloader；BepInEx 以 preloader 位置定位数据根，plugins/config 天然跟随 | ✅ 已落地（isolation.ts） |
| BEPINEX_PLUGINS_PATH 环境变量对 BepInEx 5/6 均不支持 | 已确认，不走此路 |
| ModLinker 幂等复制（size+mtime 比对）用于同步注入件 | 待落地（迁移已用 cpSync 全量复制，可优化） |
| 安装管线：cache 解压 + manifest 记录 + `.old` 后缀启停 | 部分借鉴（我们采用目录移动启停） |
| cfg 解析：section/entry/commentLines + `# Setting type:` 类型推断 | ✅ 已落地（shared/cfgparser.ts） |
| zip 导入需可执行扩展名黑名单（.dll/.exe/.bat/.ps1 等）防逃逸 | 待落地（导入功能时） |
