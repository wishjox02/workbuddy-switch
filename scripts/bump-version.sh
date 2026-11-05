#!/bin/bash
# 统一 bump 版本：usage: sh scripts/bump-version.sh 0.1.5
set -e
V=$1
[ -z "$V" ] && echo "用法: sh scripts/bump-version.sh <新版本>" && exit 1
cd "$(dirname "$0")/.."
perl -pi -e "s/\"version\": \"[0-9.]+\"/\"version\": \"$V\"/" package.json src-tauri/tauri.conf.json npm/package.json
perl -pi -e "s/^version = \"[0-9.]+\"/version = \"$V\"/" src-tauri/Cargo.toml crates/wb-switch-core/Cargo.toml crates/wb-switch-server/Cargo.toml crates/wb-switch-admin/Cargo.toml
if [ -f .env.example ]; then
  perl -pi -e "s/^VITE_APP_VERSION=[0-9.]+/VITE_APP_VERSION=$V/" .env.example
fi
# 平台包 package.json
for f in npm/platform/*/package.json; do
  perl -pi -e "s/\"version\": \"[0-9.]+\"/\"version\": \"$V\"/" "$f"
done
# 主包 optionalDependencies 引用版本（用 node 解析 JSON，避免 perl 正则误伤）
node -e "
const fs = require('fs');
const p = 'npm/package.json';
const j = JSON.parse(fs.readFileSync(p));
for (const k of Object.keys(j.optionalDependencies || {})) j.optionalDependencies[k] = '$V';
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
const lockPath = 'package-lock.json';
const lock = JSON.parse(fs.readFileSync(lockPath));
lock.version = '$V';
lock.packages[''].version = '$V';
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
"
cargo metadata --no-deps --format-version 1 >/dev/null
echo "所有版本已同步为 $V（含平台包与 optionalDependencies）"
