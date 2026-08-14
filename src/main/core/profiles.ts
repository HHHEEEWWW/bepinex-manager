/**
 * 管理器数据根目录。
 *
 * 注意：隔离模式（插件库）成为唯一形态后，快照档案（v1）已整体移除，
 * 本模块只保留数据根目录解析（isolation/installer/modnotes 均依赖）。
 */
import { join } from 'path'

/** 管理器数据根目录（可被环境变量覆盖，独立验证用） */
export function dataRootDir(): string {
  return (
    process.env.BEPINEX_MANAGER_DATA_DIR ||
    join(process.env.APPDATA ?? process.env.HOME ?? '.', 'bepinex-manager')
  )
}
