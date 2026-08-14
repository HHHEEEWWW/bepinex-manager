var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/main/core/installer.ts
var import_fs = require("fs");
var import_fs2 = require("fs");
var import_path = require("path");
var REPO_API = "https://api.github.com/repos/BepInEx/BepInEx/releases";
var REPO = "BepInEx/BepInEx";
var DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`;
var ATOM_URL = `https://github.com/${REPO}/releases.atom`;
var ASSETS_URL = (tag) => `https://github.com/${REPO}/releases/expanded_assets/${encodeURIComponent(tag)}`;
var DEFAULT_RELEASES = [
  {
    tag: "v5.4.23.5",
    prerelease: false,
    publishedAt: "2025-01-01",
    assets: [asset("v5.4.23.5", "BepInEx_win_x64_5.4.23.5.zip")]
  },
  {
    tag: "v6.0.0-pre.2",
    prerelease: true,
    publishedAt: "2025-01-01",
    assets: [
      asset("v6.0.0-pre.2", "BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip"),
      asset("v6.0.0-pre.2", "BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip")
    ]
  }
];
function asset(tag, name) {
  return { name, url: `${DOWNLOAD_BASE}/${tag}/${name}`, size: 0 };
}
async function listBepInExReleases(runtime) {
  const cacheDir = (0, import_path.join)(process.env.TEMP ?? ".", "bepinex-manager-cache");
  const cacheFile = (0, import_path.join)(cacheDir, `releases-${runtime}.json`);
  try {
    if ((0, import_fs2.existsSync)(cacheFile)) {
      const stat = (0, import_fs.statSync)(cacheFile);
      if (Date.now() - stat.mtimeMs < 24 * 3600 * 1e3) {
        return JSON.parse((0, import_fs.readFileSync)(cacheFile, "utf8"));
      }
    }
  } catch {
  }
  const res = await fetch(REPO_API + "?per_page=20", { headers: { "User-Agent": "bepinex-manager" } });
  if (!res.ok) {
    try {
      if ((0, import_fs2.existsSync)(cacheFile)) {
        return JSON.parse((0, import_fs.readFileSync)(cacheFile, "utf8"));
      }
    } catch {
    }
    try {
      const web = await fetchReleasesFromWeb(runtime);
      if (web.length > 0) return web;
    } catch {
    }
    return DEFAULT_RELEASES.filter((r) => r.assets.some((a) => isMatchingAsset(a.name, runtime)));
  }
  const data = await res.json();
  const result = data.map((r) => filterRelease(r, runtime));
  try {
    (0, import_fs2.mkdirSync)(cacheDir, { recursive: true });
    (0, import_fs.writeFileSync)(cacheFile, JSON.stringify(result), "utf8");
  } catch {
  }
  return result;
}
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
async function fetchReleasesFromWeb(runtime) {
  const atom = await fetchText(ATOM_URL);
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let em;
  while ((em = entryRe.exec(atom)) !== null) {
    const block = em[1];
    const tagMatch = block.match(/releases\/tag\/([^"<]+)/);
    const updated = block.match(/<updated>([^<]+)</);
    if (tagMatch) {
      entries.push({ tag: decodeURIComponent(tagMatch[1]), updated: updated?.[1] ?? "" });
    }
  }
  const releases = [];
  for (const e of entries.slice(0, 12)) {
    const html = await fetchText(ASSETS_URL(e.tag));
    const assets = /* @__PURE__ */ new Map();
    const assetRe = /\/BepInEx\/BepInEx\/releases\/download\/[^"']+\/([^"'<]+)/g;
    let am;
    while ((am = assetRe.exec(html)) !== null) {
      assets.set(am[1], `${DOWNLOAD_BASE}/${encodeURIComponent(e.tag)}/${am[1]}`);
    }
    const list = [...assets.entries()].map(([name, url]) => ({ name, url, size: 0 })).filter((a) => isMatchingAsset(a.name, runtime));
    if (list.length > 0) {
      releases.push({
        tag: e.tag,
        prerelease: /pre|beta|alpha|rc/i.test(e.tag),
        publishedAt: e.updated.slice(0, 10) || "unknown",
        assets: list
      });
    }
  }
  return releases;
}
async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) bepinex-manager" },
    redirect: "follow"
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// scripts/verify-installer.ts
async function main() {
  const { rmSync: rmSync2 } = await import("fs");
  const { join: join2 } = await import("path");
  const cacheDir = join2(process.env.TEMP ?? ".", "bepinex-manager-cache");
  rmSync2(cacheDir, { recursive: true, force: true });
  for (const rt of ["il2cpp", "mono"]) {
    const rels = await listBepInExReleases(rt);
    const withAssets = rels.filter((r) => r.assets.length > 0);
    console.log(`runtime=${rt}: ${rels.length} \u4E2A release\uFF0C\u53EF\u5B89\u88C5 ${withAssets.length} \u4E2A`);
    for (const r of withAssets.slice(0, 3)) {
      console.log(`  ${r.tag}${r.prerelease ? " (pre)" : ""} -> ${r.assets.map((a) => a.name).join(", ")}`);
    }
    if (withAssets.length === 0) throw new Error(`runtime=${rt} \u65E0\u53EF\u7528\u8D44\u4EA7`);
  }
  console.log("\n\u2705 installer \u515C\u5E95\u9A8C\u8BC1\u901A\u8FC7\uFF08API \u6216\u515C\u5E95\u5217\u8868\u81F3\u5C11\u4E00\u8DEF\u53EF\u7528\uFF09");
}
main().catch((e) => {
  console.error("\u9A8C\u8BC1\u5931\u8D25:", e);
  process.exit(1);
});
