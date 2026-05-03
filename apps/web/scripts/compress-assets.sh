#!/usr/bin/env bash
# Recompress every GLB under public/models/ in-place using gltf-transform
# (Meshopt geometry + WebP textures). Re-run after Unity team drops new
# raw exports into the folder — the script is idempotent: passing an
# already-compressed GLB through it is a no-op-sized output.
#
# Usage: pnpm assets:compress   (run from apps/web/)

set -euo pipefail

cd "$(dirname "$0")/.."

MODELS_DIR="public/models"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

shopt -s nullglob

files=("$MODELS_DIR"/*.glb "$MODELS_DIR"/characters/*.glb)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "no .glb files found under $MODELS_DIR"
  exit 0
fi

total_before=0
total_after=0

for f in "${files[@]}"; do
  rel="${f#$MODELS_DIR/}"
  out="$TMP_DIR/$(echo "$rel" | tr '/' '_')"
  before=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
  npx --yes @gltf-transform/cli@latest optimize "$f" "$out" \
    --texture-compress webp --compress meshopt 2>&1 | grep "info: " || true
  mv "$out" "$f"
  after=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
  total_before=$((total_before + before))
  total_after=$((total_after + after))
done

echo ""
echo "total: $((total_before / 1024 / 1024)) MB → $((total_after / 1024 / 1024)) MB"
