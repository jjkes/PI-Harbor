#!/bin/bash
# Ad-hoc re-sign the unpacked macOS app after electron-builder.
#
# electron-builder skips signing when no Developer ID identity exists, which
# leaves the bundle unsigned (only linker-signed). Once installed under
# /Applications, macOS kills the unsigned host-core child at exec time
# (cs_invalid_page → SIGKILL) and the app reports "cannot connect to the local
# service". Signing the bundled host binary first and then the whole bundle
# makes a local, non-notarized install run. Publishing needs a Developer ID and
# notarization instead.
set -euo pipefail

APP_DIR="${1:-$PWD/release/mac-arm64/PI-Harbor Desktop.app}"
HOST_BIN="$APP_DIR/Contents/Resources/bin/pi-harbor-host-core"

if [ "$(uname -s)" = "Darwin" ] && [ -f "$HOST_BIN" ]; then
  codesign --force --sign - "$HOST_BIN"
fi
codesign --force --deep --sign - "$APP_DIR"
echo "signed: $APP_DIR"
