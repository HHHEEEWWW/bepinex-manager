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
var TOOL_DIR = process.env.BEPINEX_MANAGER_TOOLS_DIR || (0, import_path3.join)(__dirname, "..", "..", "..", "tools", "plugin-metadata-reader");
var TOOL_EXE = (0, import_path3.join)(TOOL_DIR, "bin", "Release", "net9.0", "plugin-metadata-reader.exe");
var toolReady = null;
function ensureTool() {
  if (toolReady !== null) return toolReady;
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
function setPluginEnabled(bepinex, pluginId, enabled) {
  const pluginsDir = bepinex.pluginsDir;
  const disabledDir = (0, import_path4.join)(bepinex.gameDir, "BepInEx", DISABLED_DIR_NAME);
  const srcDir = enabled ? disabledDir : pluginsDir;
  const dstDir = enabled ? pluginsDir : disabledDir;
  const src = (0, import_path4.join)(srcDir, pluginId);
  if (!(0, import_fs4.existsSync)(src)) throw new Error(`\u63D2\u4EF6\u6587\u4EF6\u4E0D\u5B58\u5728: ${src}`);
  const dst = (0, import_path4.join)(dstDir, pluginId);
  (0, import_fs4.mkdirSync)((0, import_path4.dirname)(dst), { recursive: true });
  (0, import_fs4.renameSync)(src, dst);
  return enabled;
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

// src/main/core/profiles.ts
var import_fs5 = require("fs");
var import_path5 = require("path");
function profilesFilePath() {
  const dir = process.env.BEPINEX_MANAGER_DATA_DIR || (0, import_path5.join)(process.env.APPDATA ?? process.env.HOME ?? ".", "bepinex-manager");
  return (0, import_path5.join)(dir, "profiles.json");
}
var emptyStore = () => ({ games: {} });
function loadStore() {
  const file = profilesFilePath();
  if (!(0, import_fs5.existsSync)(file)) return emptyStore();
  try {
    return JSON.parse((0, import_fs5.readFileSync)(file, "utf8"));
  } catch {
    return emptyStore();
  }
}
function saveStore(store) {
  const file = profilesFilePath();
  (0, import_fs5.mkdirSync)((0, import_path5.dirname)(file), { recursive: true });
  (0, import_fs5.writeFileSync)(file, JSON.stringify(store, null, 2), "utf8");
}
function gameKey(gameDir) {
  return gameDir.toLowerCase().replace(/[\\/]+$/, "");
}
function listProfiles(gameDir) {
  const store = loadStore();
  return store.games[gameKey(gameDir)]?.profiles ?? [];
}
function createProfile(gameDir, name, states) {
  const store = loadStore();
  const key = gameKey(gameDir);
  const entry = store.games[key] ??= { currentProfileId: null, profiles: [] };
  const profile = {
    id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    pluginStates: { ...states }
  };
  entry.profiles.push(profile);
  if (!entry.currentProfileId) entry.currentProfileId = profile.id;
  saveStore(store);
  return profile;
}
function deleteProfile(gameDir, profileId) {
  const store = loadStore();
  const key = gameKey(gameDir);
  const entry = store.games[key];
  if (!entry) return;
  entry.profiles = entry.profiles.filter((p) => p.id !== profileId);
  if (entry.currentProfileId === profileId) entry.currentProfileId = entry.profiles[0]?.id ?? null;
  if (entry.profiles.length === 0) delete store.games[key];
  saveStore(store);
}
function applyProfile(bepinex, profileId) {
  const store = loadStore();
  const entry = store.games[gameKey(bepinex.gameDir)];
  const profile = entry?.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`\u6863\u6848\u4E0D\u5B58\u5728: ${profileId}`);
  const current = scanPlugins(bepinex);
  const currentStates = {};
  for (const p of current.plugins) currentStates[p.id] = p.enabled;
  const ops = [];
  for (const [relPath, target] of Object.entries(profile.pluginStates)) {
    const cur = currentStates[relPath];
    if (cur === void 0) continue;
    if (cur !== target) ops.push({ id: relPath, target, reverted: false });
  }
  const changes = [];
  let applied = 0;
  let rolledBack = 0;
  for (const op of ops) {
    try {
      setPluginEnabled(bepinex, op.id, op.target);
      applied++;
      changes.push(`${op.target ? "\u542F\u7528" : "\u7981\u7528"} ${op.id}`);
    } catch (e) {
      for (const done of ops) {
        if (done.reverted || !changes.some((c) => c.includes(done.id))) continue;
        try {
          setPluginEnabled(bepinex, done.id, !done.target);
          done.reverted = true;
          rolledBack++;
          changes.push(`\u56DE\u6EDA ${done.id}`);
        } catch {
        }
      }
      throw new Error(`\u5E94\u7528\u6863\u6848\u5931\u8D25\uFF08\u5DF2\u56DE\u6EDA ${rolledBack} \u9879\uFF09: ${e}`);
    }
  }
  if (entry) entry.currentProfileId = profileId;
  saveStore(store);
  return { applied, rolledBack, changes };
}

// src/main/core/installer.ts
function filterRelease(r, runtime) {
  return {
    tag: r.tag_name,
    prerelease: r.prerelease,
    publishedAt: r.published_at,
    assets: r.assets.filter((a) => isMatchingAsset(a.name, runtime)).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
  };
}
function isMatchingAsset(name, runtime) {
  const lower = name.toLowerCase();
  if (!lower.includes("win")) return false;
  if (!(lower.includes("x64") || lower.includes("x86_64"))) return false;
  if (runtime === "il2cpp") {
    return /unity(?:\.|\s)?il2cpp/.test(lower);
  }
  return /unity(?:\.|\s)?mono/.test(lower) || /^bepinex_win_x64/.test(lower);
}

// scripts/verify-profiles.ts
var import_fs6 = require("fs");
var TARGET_GAME = process.env.BEPINEX_MANAGER_TEST_GAME ?? "DreamEcho";
async function main() {
  const games = discoverGames();
  const target = games.find((g) => g.name.includes(TARGET_GAME) || g.gameDir.includes(TARGET_GAME));
  if (!target || !target.bepinex) {
    console.error(`\u672A\u627E\u5230\u6D4B\u8BD5\u6E38\u620F ${TARGET_GAME}\uFF08\u6216\u672A\u5B89\u88C5 BepInEx\uFF09`);
    process.exit(1);
  }
  const bepinex = target.bepinex;
  console.log(`=== Profile \u9A8C\u8BC1\uFF1A${target.name} ===`);
  const before = scanPlugins(bepinex);
  console.log(`\u521D\u59CB\u63D2\u4EF6: ${before.plugins.length} \u4E2A`);
  const profile = createProfile(bepinex.gameDir, "verify-test", Object.fromEntries(before.plugins.map((p) => [p.id, p.enabled])));
  console.log(`[1] \u5DF2\u521B\u5EFA\u6863\u6848: ${profile.id} (${Object.keys(profile.pluginStates).length} \u9879)`);
  if (!(0, import_fs6.existsSync)(profilesFilePath())) throw new Error("profiles.json \u672A\u751F\u6210");
  const r2 = applyProfile(bepinex, profile.id);
  console.log(`[2] \u5E94\u7528\u6863\u6848\uFF08\u671F\u671B 0 \u53D8\u66F4\uFF09: applied=${r2.applied} rolledBack=${r2.rolledBack}`);
  if (r2.applied !== 0) throw new Error("\u65E0\u5DEE\u5F02\u5E94\u7528\u4E0D\u5E94\u4EA7\u751F\u53D8\u66F4");
  const first = before.plugins.find((p) => p.enabled);
  if (!first) {
    console.log("\u6CA1\u6709\u542F\u7528\u7684\u63D2\u4EF6\u53EF\u6D4B\uFF0C\u8DF3\u8FC7\u53D8\u66F4\u95ED\u73AF");
  } else {
    setPluginEnabled(bepinex, first.id, false);
    const mid = scanPlugins(bepinex);
    const midState = mid.plugins.find((p) => p.id === first.id);
    console.log(`[3] \u5DF2\u7981\u7528 ${first.id}\uFF08\u5F53\u524D enabled=${midState?.enabled}\uFF09`);
    if (midState?.enabled !== false) throw new Error("\u7981\u7528\u64CD\u4F5C\u672A\u751F\u6548");
    const r3 = applyProfile(bepinex, profile.id);
    console.log(`[3b] \u5E94\u7528\u6863\u6848\uFF08\u671F\u671B 1 \u9879\u53D8\u66F4\uFF09: applied=${r3.applied} rolledBack=${r3.rolledBack} changes=[${r3.changes.join(", ")}]`);
    if (r3.applied !== 1) throw new Error("\u5E94\u7528\u6863\u6848\u5E94\u6062\u590D 1 \u4E2A\u63D2\u4EF6");
    const after = scanPlugins(bepinex);
    const afterState = after.plugins.find((p) => p.id === first.id);
    console.log(`[4] \u6062\u590D\u68C0\u67E5: ${first.id} enabled=${afterState?.enabled}`);
    if (afterState?.enabled !== true) throw new Error("\u63D2\u4EF6\u672A\u6062\u590D\u5230\u542F\u7528\u72B6\u6001");
  }
  deleteProfile(bepinex.gameDir, profile.id);
  console.log(`[5] \u5DF2\u5220\u9664\u6863\u6848\uFF0C\u5269\u4F59: ${listProfiles(bepinex.gameDir).length}`);
  console.log("\n=== BepInEx \u8D44\u4EA7\u8FC7\u6EE4\u9A8C\u8BC1\uFF08\u79BB\u7EBF fixture\uFF09 ===");
  const fixture = {
    tag_name: "v6.0.0-pre.2",
    prerelease: true,
    published_at: "2025-01-01T00:00:00Z",
    assets: [
      { name: "BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip", browser_download_url: "u1", size: 1 },
      { name: "BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip", browser_download_url: "u2", size: 2 },
      { name: "BepInEx-Unity.IL2CPP-linux-x64-6.0.0-pre.2.zip", browser_download_url: "u3", size: 3 },
      { name: "BepInEx_win_x64_5.4.23.5.zip", browser_download_url: "u4", size: 4 },
      { name: "BepInEx_win_x86_5.4.23.5.zip", browser_download_url: "u5", size: 5 }
    ]
  };
  const il2cpp = filterRelease(fixture, "il2cpp");
  const mono = filterRelease(fixture, "mono");
  console.log(`il2cpp \u8D44\u4EA7: [${il2cpp.assets.map((a) => a.name).join(", ")}]`);
  console.log(`mono \u8D44\u4EA7: [${mono.assets.map((a) => a.name).join(", ")}]`);
  if (il2cpp.assets.length !== 1 || !il2cpp.assets[0].name.includes("IL2CPP-win-x64")) {
    throw new Error("il2cpp \u8FC7\u6EE4\u7ED3\u679C\u9519\u8BEF");
  }
  if (mono.assets.length !== 2) {
    throw new Error("mono \u8FC7\u6EE4\u7ED3\u679C\u9519\u8BEF\uFF08\u5E94\u542B Unity.Mono-win-x64 \u4E0E BepInEx_win_x64_5\uFF09");
  }
  console.log("\u8D44\u4EA7\u8FC7\u6EE4\u89C4\u5219 \u2705");
  console.log("\n\u2705 Profile \u4E0E Release \u9A8C\u8BC1\u5168\u90E8\u901A\u8FC7");
}
main().catch((e) => {
  console.error("\u9A8C\u8BC1\u5931\u8D25:", e);
  process.exit(1);
});
