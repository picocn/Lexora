// Bump version following the project rule:
//   version = <major>.<minor>.<micro>
//   each build: micro + 1; when micro reaches 10, micro resets to 0 and
//   minor + 1 (major untouched). e.g. 0.1.9 -> 0.2.0.
//
// Updates the three version sources consistently:
//   package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml
//
// Usage: node scripts/bump-version.mjs [--print] [--set x.y.z]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");
const confPath = path.join(root, "src-tauri", "tauri.conf.json");
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");

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

// Canonical current version lives in tauri.conf.json.
const conf = readJson(confPath);
const current = parseVersion(conf.version);

let next;
const setIdx = args.indexOf("--set");
if (setIdx !== -1) {
  next = parseVersion(args[setIdx + 1]);
} else {
  next = bump(current);
}
const nextStr = format(next);

if (args.includes("--print")) {
  console.log(nextStr);
  process.exit(0);
}

// package.json
const pkg = readJson(pkgPath);
pkg.version = nextStr;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// tauri.conf.json
conf.version = nextStr;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

// Cargo.toml
let cargo = readFileSync(cargoPath, "utf8");
cargo = cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${nextStr}"`);
writeFileSync(cargoPath, cargo);

console.log(`version bumped: ${format(current)} -> ${nextStr}`);
