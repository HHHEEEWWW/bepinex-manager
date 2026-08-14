/**
 * BepInEx cfg 配置文件解析/序列化
 *
 * 格式示例：
 *   ## 注释
 *   # Setting type: Boolean
 *   # Default value: true
 *   EnableFeature = true
 *
 * 类型推断来源：
 *   - "# Setting type: Boolean|Int32|Single|String|Enum"
 *   - "# Acceptable values: A, B, C"（枚举可选值）
 */
export interface CfgEntry {
  key: string
  /** 当前值（字符串形式） */
  value: string
  /** 条目上方的注释行（原样保留） */
  comments: string[]
  /** 推断的设置类型（Boolean/Int32/Single/String/Enum/unknown） */
  settingType: string
  /** 枚举可接受值（仅 Enum 类型） */
  acceptableValues: string[] | null
  /** 默认值（来自 # Default value 注释） */
  defaultValue: string | null
}

export interface CfgSection {
  name: string
  entries: CfgEntry[]
}

export interface CfgDocument {
  /** [Section] 之前的头部行（如文件头注释） */
  headerLines: string[]
  sections: CfgSection[]
}

/** 解析 cfg 文本 */
export function parseCfg(text: string): CfgDocument {
  const doc: CfgDocument = { headerLines: [], sections: [] }
  let currentSection: CfgSection | null = null
  let pendingComments: string[] = []
  const lines = text.split(/\r?\n/)

  for (const raw of lines) {
    const line = raw.trimEnd()
    const trimmed = line.trim()

    if (trimmed === '') {
      // 空行：清空待定注释归属（注释和条目之间允许空行？保守：不清空）
      continue
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const name = trimmed.slice(1, -1).trim()
      // 第一个 section 前的注释行 → 文档头部
      if (doc.sections.length === 0) {
        doc.headerLines = pendingComments
      }
      currentSection = { name, entries: [] }
      doc.sections.push(currentSection)
      pendingComments = []
      continue
    }
    if (trimmed.startsWith('##') || trimmed.startsWith('#')) {
      // 注释先收集，遇到 Key = Value 时再提取特殊注释（类型/默认值/枚举）
      pendingComments.push(line)
      continue
    }
    // Key = Value
    const eq = trimmed.indexOf('=')
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      // 从待定注释中提取特殊注释
      const special = extractSpecialComments(pendingComments)
      const entry: CfgEntry = {
        key,
        value,
        comments: special.comments,
        settingType: special.settingType,
        acceptableValues: special.acceptableValues,
        defaultValue: special.defaultValue
      }
      if (currentSection) {
        currentSection.entries.push(entry)
      } else {
        // 头部区域的键值（少见），归入默认 section
        currentSection = { name: '', entries: [] }
        doc.sections.push(currentSection)
        currentSection.entries.push(entry)
      }
      pendingComments = []
      continue
    }
    // 其他行：保留为注释归属
    pendingComments.push(line)
  }

  return doc
}

/**
 * 从注释行中提取特殊注释（# Setting type / # Default value / # Acceptable values），
 * 其余作为普通注释返回。
 */
function extractSpecialComments(comments: string[]): {
  comments: string[]
  settingType: string
  acceptableValues: string[] | null
  defaultValue: string | null
} {
  const result = {
    comments: [] as string[],
    settingType: 'unknown' as string,
    acceptableValues: null as string[] | null,
    defaultValue: null as string | null
  }
  for (const c of comments) {
    const t = c.trim()
    const typeMatch = t.match(/^#\s*Setting type:\s*(.+)$/i)
    if (typeMatch) {
      result.settingType = normalizeType(typeMatch[1].trim())
      continue
    }
    const defMatch = t.match(/^#\s*Default value:\s*(.+)$/i)
    if (defMatch) {
      result.defaultValue = defMatch[1].trim()
      continue
    }
    const accMatch = t.match(/^#\s*Acceptable values:\s*(.+)$/i)
    if (accMatch) {
      result.acceptableValues = accMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
      result.settingType = 'Enum'
      continue
    }
    result.comments.push(c)
  }
  return result
}

/** 归一化类型名 */
function normalizeType(t: string): string {
  const lower = t.toLowerCase()
  if (lower.includes('bool')) return 'Boolean'
  if (lower.includes('int32') || lower.includes('int')) return 'Int32'
  if (lower.includes('single') || lower.includes('float')) return 'Single'
  if (lower.includes('string') || lower.includes('text')) return 'String'
  return t
}

/** 把文档序列化为 cfg 文本 */
export function serializeCfg(doc: CfgDocument): string {
  const out: string[] = []
  for (const h of doc.headerLines) out.push(h)
  if (doc.headerLines.length > 0) out.push('')

  for (const section of doc.sections) {
    out.push(`[${section.name}]`)
    out.push('')
    for (const e of section.entries) {
      for (const c of e.comments) out.push(c)
      // 重新输出类型/默认值注释（若原始注释没有，补充一次；简化：仅当 comments 中无对应注释时补）
      const hasType = e.comments.some((c) => /Setting type:/i.test(c))
      if (!hasType && e.settingType !== 'unknown') {
        out.push(`# Setting type: ${e.settingType}`)
      }
      if (e.acceptableValues && !e.comments.some((c) => /Acceptable values:/i.test(c))) {
        out.push(`# Acceptable values: ${e.acceptableValues.join(', ')}`)
      }
      if (e.defaultValue !== null && !e.comments.some((c) => /Default value:/i.test(c))) {
        out.push(`# Default value: ${e.defaultValue}`)
      }
      out.push(`${e.key} = ${e.value}`)
      out.push('')
    }
  }
  return out.join('\n')
}
