// src/main/core/games.ts
var import_child_process = require("child_process");
var import_fs2 = require("fs");
var import_path2 = require("path");

// src/main/core/bepinex.ts
var import_fs = require("fs");
var import_path = require("path");
function detectBepInEx(gameDir) {
  const bepinexDir = (0, import_path.join)(gameDir, "BepInEx");
  if (!(0, import_fs.existsSync)(bepinexDir)) return null;
  const coreDir = (0, import_path.join)(bepinexDir, "core");
  const pluginsDir = (0, import_path.join)(bepinexDir, "plugins");
  const configDir = (0, import_path.join)(bepinexDir, "config");
  const logFile = (0, import_path.join)(bepinexDir, "LogOutput.log");
  const hasInterop = (0, import_fs.existsSync)((0, import_path.join)(bepinexDir, "interop"));
  const hasCore5 = (0, import_fs.existsSync)((0, import_path.join)(coreDir, "BepInEx.dll"));
  const hasCore6 = (0, import_fs.existsSync)((0, import_path.join)(coreDir, "BepInEx.Core.dll"));
  if (!hasCore5 && !hasCore6 && !hasInterop) {
    return null;
  }
  const isMono = hasCore5 || !hasInterop && !hasCore6;
  const majorVersion = hasInterop || hasCore6 ? 6 : 5;
  return {
    gameDir,
    majorVersion: isMono ? majorVersion : 6,
    isMono,
    coreDir,
    pluginsDir,
    configDir,
    logFile: (0, import_fs.existsSync)(logFile) ? logFile : null,
    version: readVersionFromLog(logFile)
  };
}
function readVersionFromLog(logFile) {
  if (!(0, import_fs.existsSync)(logFile)) return null;
  try {
    const head = (0, import_fs.readFileSync)(logFile, "utf8").slice(0, 8192);
    const m = head.match(/BepInEx\s+(\d+\.\d+(?:\.\d+){0,2})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// src/main/core/games.ts
function discoverGames() {
  const games = [];
  const steamPath = findSteamPath();
  if (steamPath) {
    const libs = readLibraryFolders(steamPath);
    const seen = /* @__PURE__ */ new Set();
    for (const lib of libs) {
      const commonDir = (0, import_path2.join)(lib, "steamapps", "common");
      if (!(0, import_fs2.existsSync)(commonDir)) continue;
      for (const entry of readAcfEntries(lib)) {
        const gameDir = (0, import_path2.join)(commonDir, entry.installdir);
        if (!(0, import_fs2.existsSync)(gameDir)) continue;
        const key = gameDir.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        games.push({
          id: hashId(gameDir),
          name: entry.name,
          gameDir,
          source: "steam",
          steamAppId: entry.appid,
          bepinex: detectBepInEx(gameDir)
        });
      }
    }
  }
  return games;
}
function findSteamPath() {
  try {
    const out = (0, import_child_process.execFileSync)("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], {
      encoding: "utf8"
    });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) return m[1].trim().replace(/\\+$/, "");
  } catch {
  }
  return null;
}
function readLibraryFolders(steamPath) {
  const vdfPath = (0, import_path2.join)(steamPath, "steamapps", "libraryfolders.vdf");
  if (!(0, import_fs2.existsSync)(vdfPath)) return [steamPath];
  try {
    const text = (0, import_fs2.readFileSync)(vdfPath, "utf8");
    const paths = [];
    const re = /"path"\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const p = m[1].replace(/\\\\/g, "\\");
      if (!paths.includes(p)) paths.push(p);
    }
    return paths.length > 0 ? paths : [steamPath];
  } catch {
    return [steamPath];
  }
}
function readAcfEntries(libPath) {
  const appsDir = (0, import_path2.join)(libPath, "steamapps");
  if (!(0, import_fs2.existsSync)(appsDir)) return [];
  try {
    const entries = [];
    for (const f of (0, import_fs2.readdirSync)(appsDir)) {
      const m = f.match(/^appmanifest_(\d+)\.acf$/);
      if (!m) continue;
      const text = (0, import_fs2.readFileSync)((0, import_path2.join)(appsDir, f), "utf8");
      const name = text.match(/"name"\s*"([^"]+)"/)?.[1];
      const installdir = text.match(/"installdir"\s*"([^"]+)"/)?.[1];
      if (name && installdir) {
        entries.push({ appid: Number(m[1]), name, installdir });
      }
    }
    return entries;
  } catch {
    return [];
  }
}
function hashId(path) {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "g" + (h >>> 0).toString(16);
}

// src/main/core/plugins.ts
var import_fs4 = require("fs");
var import_path4 = require("path");

// src/main/core/metadata.ts
var import_child_process2 = require("child_process");
var import_fs3 = require("fs");
var import_path3 = require("path");
function findToolDir() {
  const candidates = [];
  if (process.env.BEPINEX_MANAGER_TOOLS_DIR) {
    candidates.push(process.env.BEPINEX_MANAGER_TOOLS_DIR);
  }
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    candidates.push((0, import_path3.join)(dir, "tools", "plugin-metadata-reader"));
    dir = (0, import_path3.dirname)(dir);
  }
  return candidates.find((d) => (0, import_fs3.existsSync)((0, import_path3.join)(d, "plugin-metadata-reader.csproj"))) ?? null;
}
var TOOL_DIR = findToolDir() ?? "";
var TOOL_EXE = TOOL_DIR ? (0, import_path3.join)(TOOL_DIR, "bin", "Release", "net9.0", "plugin-metadata-reader.exe") : "";
var toolReady = null;
function ensureTool() {
  if (toolReady !== null) return toolReady;
  if (!TOOL_DIR) {
    toolReady = false;
    return false;
  }
  if ((0, import_fs3.existsSync)(TOOL_EXE)) {
    toolReady = true;
    return true;
  }
  try {
    const r = (0, import_child_process2.spawnSync)("dotnet", ["build", TOOL_DIR, "-c", "Release", "--nologo", "-v", "q"], {
      encoding: "utf8",
      timeout: 18e4
    });
    toolReady = r.status === 0 && (0, import_fs3.existsSync)(TOOL_EXE);
    if (!toolReady && r.stderr) console.error("[metadata] dotnet build failed:", r.stderr.slice(0, 800));
  } catch (e) {
    console.error("[metadata] dotnet build error:", e);
    toolReady = false;
  }
  return toolReady;
}
function resolvePluginMetadata(plugins, bepinex) {
  if (plugins.length === 0) return;
  const dlls = plugins.map((p) => p.fullPath);
  if (!ensureTool()) {
    for (const p of plugins) p.metaError = "C# \u5143\u6570\u636E\u89E3\u6790\u5DE5\u5177\u4E0D\u53EF\u7528\uFF08\u9700\u8981 .NET SDK \u6216\u9884\u6784\u5EFA\u4EA7\u7269\uFF09";
    return;
  }
  try {
    const r = (0, import_child_process2.spawnSync)(
      TOOL_EXE,
      ["--core", bepinex.coreDir, "--plugins", bepinex.pluginsDir],
      {
        input: dlls.join("\n") + "\n",
        encoding: "utf8",
        timeout: 12e4,
        maxBuffer: 64 * 1024 * 1024
      }
    );
    if (r.status !== 0) {
      const err = (r.stderr || "").slice(0, 500);
      for (const p of plugins) p.metaError = `\u89E3\u6790\u5DE5\u5177\u9000\u51FA\u7801 ${r.status}: ${err}`;
      return;
    }
    const byPath = /* @__PURE__ */ new Map();
    for (const line of r.stdout.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (typeof obj.path !== "string") continue;
        if (obj.error) {
          byPath.set(obj.path, { meta: null, error: String(obj.error) });
        } else {
          byPath.set(obj.path, {
            meta: {
              guid: String(obj.guid),
              name: String(obj.name),
              version: String(obj.version),
              dependencies: Array.isArray(obj.dependencies) ? obj.dependencies.map(String) : []
            },
            error: null
          });
        }
      } catch {
      }
    }
    for (const p of plugins) {
      const hit = byPath.get(p.fullPath);
      p.meta = hit?.meta ?? null;
      p.metaError = hit?.error ?? null;
    }
  } catch (e) {
    for (const p of plugins) p.metaError = `\u89E3\u6790\u5F02\u5E38: ${e}`;
  }
}

// src/main/core/plugins.ts
var DISABLED_DIR_NAME = "plugins-disabled";
function scanPlugins(bepinex) {
  const pluginsDir = bepinex.pluginsDir;
  const disabledDir = (0, import_path4.join)(bepinex.gameDir, "BepInEx", DISABLED_DIR_NAME);
  const enabled = collectDlls(pluginsDir, pluginsDir, true);
  const disabled = collectDlls(disabledDir, disabledDir, false);
  const all = [...enabled, ...disabled];
  resolvePluginMetadata(all, bepinex);
  for (const p of all) {
    if (p.meta?.guid) {
      const cfg = (0, import_path4.join)(bepinex.configDir, `${p.meta.guid}.cfg`);
      p.configFile = (0, import_fs4.existsSync)(cfg) ? cfg : null;
    }
  }
  return {
    game: {
      id: hashId2(bepinex.gameDir),
      name: bepinex.gameDir.split(/[\\/]/).filter(Boolean).pop() ?? "",
      gameDir: bepinex.gameDir,
      source: "manual",
      bepinex
    },
    plugins: all,
    hasDisabledDir: (0, import_fs4.existsSync)(disabledDir)
  };
}
function collectDlls(rootDir, baseDir, enabled) {
  if (!(0, import_fs4.existsSync)(rootDir)) return [];
  const result = [];
  const walk = (dir) => {
    let items;
    try {
      items = (0, import_fs4.readdirSync)(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".") || item.name === DISABLED_DIR_NAME) continue;
      const full = (0, import_path4.join)(dir, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (item.name.toLowerCase().endsWith(".dll")) {
        const rel = (0, import_path4.relative)(baseDir, full).replace(/\\/g, "/");
        result.push({
          id: rel,
          fileName: item.name,
          relPath: rel,
          fullPath: full,
          sizeBytes: (0, import_fs4.statSync)(full).size,
          enabled,
          meta: null,
          configFile: null,
          metaError: null
        });
      }
    }
  };
  walk(rootDir);
  return result;
}
function hashId2(path) {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "g" + (h >>> 0).toString(16);
}

// scripts/diag-metadata.ts
for (const g of discoverGames().filter((x) => x.bepinex)) {
  const r = scanPlugins(g.bepinex);
  console.log(`== ${g.name} (${g.gameDir}) plugins=${r.plugins.length}`);
  for (const p of r.plugins) {
    console.log(`   [${p.enabled ? "ON" : "OFF"}] ${p.fileName}`);
    console.log(`       meta=${p.meta ? JSON.stringify(p.meta) : "null"}`);
    if (p.metaError) console.log(`       error=${p.metaError}`);
  }
}
console.log("diag done");
