#!/usr/bin/env bash
# Install script ของ environment ใน Codex cloud: ไม่มี root, ไม่มี Docker และ home ของผู้ใช้อาจไม่มีอยู่จริง
# จึงย้ายที่เก็บของ pnpm / npm / corepack มาไว้ใต้ /workspace (ตั้ง environment variable ชุดเดียวกันใน Codex ด้วย)
set -euo pipefail
cd "$(dirname "$0")/.."

: "${XDG_DATA_HOME:=/workspace/.local/share}"
: "${XDG_CACHE_HOME:=/workspace/.cache}"
: "${XDG_CONFIG_HOME:=/workspace/.config}"
: "${COREPACK_HOME:=$XDG_CACHE_HOME/corepack}"
: "${npm_config_cache:=$XDG_CACHE_HOME/npm}"
export XDG_DATA_HOME XDG_CACHE_HOME XDG_CONFIG_HOME COREPACK_HOME npm_config_cache
mkdir -p "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$COREPACK_HOME" "$npm_config_cache"

PNPM="pnpm"
command -v pnpm >/dev/null || PNPM="corepack pnpm"
$PNPM install --frozen-lockfile
bash scripts/setup-postgres.sh
