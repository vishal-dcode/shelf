// Store packages for Chrome Web Store and Firefox Add-ons.
//   node scripts/build.mjs          -> dist/chrome/, dist/firefox/ and a .zip of each
//   node scripts/build.mjs --allow-placeholders   (local test build only)
// A store build refuses to run while lib/config.js still has placeholders,
// or while the manifest's server origins don't match it.
// Only the runtime files below are packaged: no tests, docs, source notes or
// personal backups. No dependencies; the zip writer is at the bottom.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, lstatSync, copyFileSync } from "node:fs";
import { join, dirname, extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

// Runtime files and folders, relative to the repo root.
const INCLUDE = [
  "background.js",
  "newtab.html",
  "newtab.js",
  "sidepanel.html",
  "sidepanel.js",
  "theme-init.js",
  "lib",
  "styles",
  "fonts",
  "icons",
];

// Must never change once the add-on is listed on AMO.
const GECKO_ID = "shelf-tabmanager@vishal-dcode";

const source = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const { CONFIG, PLACEHOLDER } = await import(new URL("../lib/config.js", import.meta.url));

// The manifest must allow exactly the two servers in lib/config.js.
function checkServers() {
  const origins = [CONFIG.clerkFrontendApi, CONFIG.apiBase].map((u) => new URL(u).origin);
  const hosts = origins.map((o) => `${o}/*`);
  const problems = [];
  if (JSON.stringify(source.host_permissions) !== JSON.stringify(hosts)) {
    problems.push(`manifest host_permissions must be ${JSON.stringify(hosts)}`);
  }
  const connect = /connect-src ([^;]*)/.exec(source.content_security_policy.extension_pages)?.[1].trim();
  if (connect !== origins.join(" ")) problems.push(`manifest CSP connect-src must be "${origins.join(" ")}"`);
  if (problems.length) throw new Error(problems.join(" / "));
  const unset = Object.entries(CONFIG).filter(([, v]) => PLACEHOLDER.test(v)).map(([k]) => k);
  if (unset.length && !process.argv.includes("--allow-placeholders")) {
    throw new Error(`lib/config.js still has placeholders: ${unset.join(", ")}. Fill them in or pass --allow-placeholders for a local test build.`);
  }
  if (unset.length) console.warn(`warning: test build with placeholders (${unset.join(", ")}); sign-in is switched off in it.`);
}
checkServers();

function chromeManifest() {
  return structuredClone(source);
}

function firefoxManifest() {
  const m = structuredClone(source);
  delete m.minimum_chrome_version;
  delete m.side_panel;
  // Firefox runs MV3 background code as an event page, not a service worker.
  m.background = { scripts: ["background.js"], type: "module" };
  // No side panel API and no extension icon cache in Firefox.
  m.permissions = m.permissions.filter((p) => p !== "sidePanel" && p !== "favicon");
  m.sidebar_action = {
    default_title: "Shelf",
    default_panel: "sidepanel.html",
    default_icon: { 16: "icons/16.png", 32: "icons/32.png" },
    open_at_install: false,
  };
  m.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: "140.0",
      // Nothing is sent unless someone signs in; then Firefox asks first
      // (lib/auth.js requests these at the "Sign in" click).
      data_collection_permissions: {
        required: ["none"],
        optional: ["authenticationInfo", "personallyIdentifyingInfo", "browsingActivity"],
      },
    },
  };
  return m;
}

// Only these file types are packaged, so a stray editor backup, OS file or
// symlink dropped into lib/, styles/, fonts/ or icons/ never ships.
const PACKAGED = new Set([".js", ".html", ".css", ".json", ".woff2", ".txt", ".png", ".svg"]);

function listFiles(path) {
  const full = join(ROOT, path);
  const info = lstatSync(full);
  if (info.isSymbolicLink()) throw new Error(`Refusing to package a symlink: ${path}`);
  if (info.isDirectory()) {
    return readdirSync(full)
      .filter((name) => !name.startsWith("."))
      .flatMap((name) => listFiles(join(path, name)));
  }
  if (!info.isFile() || !PACKAGED.has(extname(path))) return [];
  return [path];
}

function build(target, manifest) {
  const out = join(DIST, target);
  rmSync(out, { recursive: true, force: true });
  const files = INCLUDE.flatMap(listFiles).sort();
  const entries = [];
  for (const file of files) {
    const dest = join(out, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(ROOT, file), dest);
    entries.push({ name: file.split(sep).join("/"), data: readFileSync(join(ROOT, file)) });
  }
  const manifestData = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(out, "manifest.json"), manifestData);
  entries.unshift({ name: "manifest.json", data: manifestData });

  const zipPath = join(DIST, `shelf-${target}-${manifest.version}.zip`);
  writeFileSync(zipPath, zip(entries));
  console.log(`${target}: ${entries.length} files -> ${relative(ROOT, zipPath)}`);
}

// Minimal zip (deflate, no extras). Fixed timestamps keep builds reproducible.
function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

mkdirSync(DIST, { recursive: true });
build("chrome", chromeManifest());
build("firefox", firefoxManifest());
