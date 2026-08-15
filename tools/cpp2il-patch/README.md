# Cpp2IL Unity 6 兼容补丁

## 背景

Unity 6 (6000.x) 大游戏的 `Il2CppMetadataRegistration` 计数字段可超过
Cpp2IL 写死的 sanity limit `0xC0000`（786,432），导致 Cpp2IL 拒绝候选
注册表位置（`metareg: 0x0`），BepInEx 的 InteropManager 生成 interop 失败，
报错：

```
Failed to generate Il2Cpp interop assemblies:
LibCpp2ILInitializationException: Failed to find code registration or metadata registration!
```

典型触发：Pax Autocratica 2026-08-15 更新（Unity 6000.0.37f1）后
metareg 计数字段 0xCFE2E / 0xD04C4（约 85 万）> 0xC0000。

上游 Cpp2IL development 分支尚未修复（sanity limit 仍为 0xC0000，
见 https://github.com/SamboyCoding/Cpp2IL/issues/500 同类问题）。

## 补丁内容

基于 be.785 内置的同版本 Cpp2IL 源码（commit `558ddd9`，即
`2022.1.0-development.1452`），仅修改一处：

- `LibCpp2IL/BinarySearcher.cs`：metareg 校验的 sanity limit
  `0xC0000` → `0x400000`（约 419 万，覆盖更大规模游戏）

重新编译 `Cpp2IL.Core.dll` + `LibCpp2IL.dll`（net6.0），程序集引用与
原版逐一对齐（AsmResolver 6.0.0 / AssetRipper.CIL 1.2.2 / Iced 1.21 等）。

## 文件

| 文件 | 用途 |
|---|---|
| `Cpp2IL.Core.dll` | 补丁版 Cpp2IL.Core（含 limit 修复） |
| `LibCpp2IL.dll` | 补丁版 LibCpp2IL（含 limit 修复） |

## 部署方式（安装链自动执行）

BPM 在 `installBepInExToLibrary` 安装/重建档案后自动检测 core 目录的
`Cpp2IL.Core.dll`，若其内嵌 sanity limit 仍为 `0xC0000`（旧版未修复），
则替换为补丁版（原文件先备份到 `core/bak-cpp2il-*/`）。

未来若上游 Cpp2IL 发布修复版本（limit ≥ 0x400000 或其他修复），
检测逻辑自动跳过替换，补丁自然退役。
