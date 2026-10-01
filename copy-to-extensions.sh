#!/usr/bin/env bash
# Sync pi-twiddle source to the Pi extensions dir for local testing.
# Copies runtime sources only; never touches config.json.
# After running, reload Pi with /reload.
set -euo pipefail

SRC="/home/bscordeiro/workspace/pi-twiddle"
DEST="/home/bscordeiro/.pi/agent/extensions/pi-twiddle"

mkdir -p "$DEST"
cp \
  "$SRC/index.ts" \
  "$SRC/config.ts" \
  "$SRC/footer.ts" \
  "$SRC/intent.ts" \
  "$SRC/picker.ts" \
  "$SRC/optimizer.ts" \
  "$SRC/preserve.ts" \
  "$SRC/project.ts" \
  "$SRC/tokenizer.ts" \
  "$SRC/missing-model-warning.ts" \
  "$SRC/history.ts" \
  "$DEST"/

echo "Synced ${SRC} -> ${DEST} (config.json preserved). Run /reload in pi."
