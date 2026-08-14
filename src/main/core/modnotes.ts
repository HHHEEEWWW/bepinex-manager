/**
 * Mod 说明系统：插件卡片上展示的说明文字。
 *
 * 数据来源（优先级从高到低）：
 *   1. 用户自定义：<dataRoot>/mod-notes/<GUID>.txt（UTF-8 无 BOM）
 *   2. 内置说明表（内置已知 mod 的说明，随管理器更新）
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { dataRootDir } from './profiles'

/** 内置说明：GUID -> 说明文字 */
const BUILTIN_NOTES: Record<string, string> = {
  'com.hhewww.paxautocraticahelper':
    '《暗星铁律》士兵管理 + 快捷命令。\n' +
    '【面板】F1 开关：士兵列表/属性编辑（改完点「应用属性」生效）。\n' +
    '【士兵】F2 复制当前士兵（需先选中）；F3 应用属性。\n' +
    '【快捷键】Ctrl+1 时间2x · Ctrl+2 时间5x · Ctrl+3 时间10x · Ctrl+4 时间1x\n' +
    'Ctrl+5 完成所有研究 · Ctrl+6 自动保存 · Ctrl+7 God Mode · Ctrl+8 Daddy Mode\n' +
    'Ctrl+9 免费制造开 · Ctrl+0 智能自动分配\n' +
    '【配置】机器人强化数值、自动分配间隔、面板布局均可配置（本管理器「⚙ 配置」表单化编辑）。'
}

/** 获取插件说明（自定义文件优先，其次内置） */
export function getModNote(guid: string): string | null {
  // 用户自定义说明
  try {
    const custom = join(dataRootDir(), 'mod-notes', `${guid}.txt`)
    if (existsSync(custom)) {
      const text = readFileSync(custom, 'utf8').trim()
      if (text) return text
    }
  } catch {
    /* 读取失败则回退内置 */
  }
  return BUILTIN_NOTES[guid] ?? null
}
