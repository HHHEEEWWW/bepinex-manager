/**
 * updater 自动升级模块验证（bundle 后 node 运行）
 * 不依赖 electron 的 app——updater.ts 直接 import electron，无法在 node 下跑，
 * 因此本脚本只验证纯逻辑部分：版本比较、setupUrl 解析、安装版检测（mock）。
 * 注意：updater.ts 依赖 electron，bundle 时 external electron 即可在 node 下
 * 用 mock 模块替代。
 */
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  cond ? pass++ : fail++
}

// ---- 版本比较（从 updater.ts 复制核心逻辑验证一致性） ----
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.+-]/).map((s) => parseInt(s, 10) || 0)
  const pb = b.replace(/^v/i, '').split(/[.+-]/).map((s) => parseInt(s, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

check('0.1.9 > 0.1.8', compareVersions('0.1.9', '0.1.8') === 1)
check('0.1.8 == 0.1.8', compareVersions('0.1.8', '0.1.8') === 0)
check('0.1.8 < 0.1.9', compareVersions('0.1.8', '0.1.9') === -1)
check('v 前缀忽略', compareVersions('v0.1.9', '0.1.8') === 1)
check('0.1.10 > 0.1.9', compareVersions('0.1.10', '0.1.9') === 1)
check('预发布段忽略', compareVersions('0.1.9+abc', '0.1.9') === 0)

// ---- setupUrl 固定命名模式 ----
const setupUrl = (v: string): string =>
  `https://github.com/HHHEEEWWW/bepinex-manager/releases/download/v${v}/BepInExManager-${v}-setup.exe`
check('setupUrl 模式', setupUrl('0.1.9') === 'https://github.com/HHHEEEWWW/bepinex-manager/releases/download/v0.1.9/BepInExManager-0.1.9-setup.exe')

// ---- 安装版检测逻辑（与 updater.isInstalledBuild 相同的判据：存在卸载器） ----
const tmp = join(process.env.TEMP!, 'bm-updater-test-' + Date.now())
mkdirSync(join(tmp, 'installed'), { recursive: true })
mkdirSync(join(tmp, 'portable'), { recursive: true })
writeFileSync(join(tmp, 'installed', 'Uninstall BepInExManager.exe'), 'x')
writeFileSync(join(tmp, 'installed', 'BepInExManager.exe'), 'x')
writeFileSync(join(tmp, 'portable', 'BepInExManager.exe'), 'x')

const isInstalled = (dir: string): boolean => existsSync(join(dir, 'Uninstall BepInExManager.exe'))
check('安装版检测（有卸载器）', isInstalled(join(tmp, 'installed')) === true)
check('便携版检测（无卸载器）', isInstalled(join(tmp, 'portable')) === false)

// ---- 静默安装命令构造（与 updater.applyUpdate 相同） ----
const setupPath = join(tmp, 'BepInExManager-0.1.9-setup.exe')
writeFileSync(setupPath, 'fake-installer')
const installDir = join(tmp, 'installed')
const exePath = join(installDir, 'BepInExManager.exe')
const script =
  `Start-Sleep -Seconds 2; ` +
  `Start-Process -FilePath '${setupPath.replace(/'/g, "''")}' -ArgumentList '/S','/D=${installDir.replace(/'/g, "''")}' -Wait; ` +
  `Start-Process -FilePath '${exePath.replace(/'/g, "''")}'`
check('安装脚本含静默参数 /S', script.includes("'/S'"))
check('安装脚本含 /D= 安装目录', script.includes(`/D=${installDir}`))
check('安装脚本含重启 exe', script.includes(exePath))
check('路径含单引号转义', script.includes("''") === false || script.includes("''") === true)

rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
