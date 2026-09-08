// Bump version following the project rule:
//   version = <major>.<minor>.<micro>
//   each build: micro + 1; when micro reaches 10, micro resets to 0 and
//   minor + 1 (major untouched). e.g. 0.1.9 -> 0.2.0.
//
// Updates the version sources consistently:
//   package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml
// and keeps their lockfiles in sync:
//   package-lock.json (root + packages[""] name/version),
//   src-tauri/Cargo.lock (the [[package]] lexora version line).
//
// Usage:
//   node scripts/bump-version.mjs            # bump once (0.1.2 -> 0.1.3)
//   node scripts/bump-version.mjs --set 1.2.3
//   node scripts/bump-version.mjs --print    # print the CURRENT version
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");
const confPath = path.join(root, "src-tauri", "tauri.conf.json");
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const cargoLockPath = path.join(root, "src-tauri", "Cargo.lock");
const pkgLockPath = path.join(root, "package-lock.json");

const args = process.argv.slice(2);

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) throw new Error(`无法解析版本号: ${v}`);
  return { major: +m[1], minor: +m[2], micro: +m[3] };
}

function format({ major, minor, micro }) {
  return `${major}.${minor}.${micro}`;
}

function bump(v) {
  let micro = v.micro + 1;
  let minor = v.minor;
  if (micro >= 10) {
    micro = 0;
    minor += 1;
  }
  return { major: v.major, minor, micro };
}

// Canonical current version lives in tauri.conf.json (see vite.config.ts).
const conf = readJson(confPath);
const current = parseVersion(conf.version);

if (args.includes("--print")) {
  console.log(format(current));
  process.exit(0);
}

let next;
const setIdx = args.indexOf("--set");
if (setIdx !== -1) {
  next = parseVersion(args[setIdx + 1]);
} else {
  next = bump(current);
}
const nextStr = format(next);

// package.json
const pkg = readJson(pkgPath);
pkg.version = nextStr;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// tauri.conf.json
conf.version = nextStr;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

// Cargo.toml — replace only the `version = "..."` line inside the [package]
// table (a later per-dependency `[dependencies.foo]` table must not be hit).
function replaceCargoTomlVersion(text, next) {
  const lines = text.split("\n");
  const pkgIdx = lines.findIndex((l) => l.trim() === "[package]");
  if (pkgIdx === -1) throw new Error("Cargo.toml: 找不到 [package] 段");
  for (let i = pkgIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("[")) break; // reached the next table
    if (/^version\s*=\s*"[^"]+"/.test(t)) {
      lines[i] = lines[i].replace(/"[^"]+"/, `"${next}"`);
      writeFileSync(cargoPath, lines.join("\n"));
      return;
    }
  }
  throw new Error("Cargo.toml: [package] 段内找不到 version");
}

// Cargo.lock — update the version line of the `lexora` package block so the
// lockfile and Cargo.toml agree (cargo rewrites it anyway; keep the diff tidy).
function replaceCargoLockVersion(text, next) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\[\[package\]\]/.test(lines[i])) continue;
    let nameIdx = -1;
    let j = i + 1;
    while (j < lines.length && !/^\[\[?/.test(lines[j])) {
      if (/^name\s*=\s*"lexora"/.test(lines[j])) {
        nameIdx = j;
        break;
      }
      j++;
    }
    if (nameIdx === -1) continue;
    for (let k = nameIdx + 1; k < lines.length && !/^\[\[?/.test(lines[k]); k++) {
      if (/^version\s*=\s*"[^"]+"/.test(lines[k])) {
        lines[k] = lines[k].replace(/"[^"]+"/, `"${next}"`);
        writeFileSync(cargoLockPath, lines.join("\n"));
        return;
      }
    }
  }
  throw new Error("Cargo.lock: 找不到 lexora 包版本行");
}

// package-lock.json — mirror the package.json name/version (root + packages[""]).
function replacePackageLock(pkgName, next) {
  const lock = readJson(pkgLockPath);
  if (lock.name) lock.name = pkgName;
  lock.version = next;
  if (lock.packages && lock.packages[""]) {
    if (lock.packages[""].name) lock.packages[""].name = pkgName;
    lock.packages[""].version = next;
  }
  writeFileSync(pkgLockPath, JSON.stringify(lock, null, 2) + "\n");
}

replaceCargoTomlVersion(readFileSync(cargoPath, "utf8"), nextStr);
replaceCargoLockVersion(readFileSync(cargoLockPath, "utf8"), nextStr);
replacePackageLock(pkg.name, nextStr);

console.log(`version bumped: ${format(current)} -> ${nextStr}`);
