#!/usr/bin/env bash
#
# build-macos.sh — produce a macOS .app/.zip from the Linux Azeron AppImage.
#
# Given (or downloading) the official AppImage, this:
#   1. extracts the embedded squashfs and the app.asar payload
#   2. overlays the unpacked native modules
#   3. applies our macOS changes (scripts/apply-macos-changes.js)
#   4. stages firmware + generates an .icns from the bundled icon
#   5. runs electron-builder (ad-hoc signed, hardened runtime)
#
# Usage:
#   scripts/build-macos.sh [--version X.Y.Z] [--appimage /path/to.AppImage]
#
# Env:
#   AZERON_VERSION   default upstream version (default: 2.0.2)
#   APPIMAGE_URL     override the download URL
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

VERSION="${AZERON_VERSION:-2.0.2}"
APPIMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --appimage) APPIMAGE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

URL="${APPIMAGE_URL:-https://azeron-software-public.s3.us-east-1.amazonaws.com/live/${VERSION}/Azeron-Software-v${VERSION}.AppImage}"
WORK="$REPO/work"
SQUASH="$WORK/squashfs-root"
APPDIR="$WORK/app"

echo "==> Azeron macOS build (version $VERSION)"
rm -rf "$WORK"
mkdir -p "$WORK"

# 1. Obtain the AppImage
if [ -z "$APPIMAGE" ]; then
  APPIMAGE="$WORK/Azeron-Software-v${VERSION}.AppImage"
  echo "==> Downloading $URL"
  curl -fsSL "$URL" -o "$APPIMAGE"
fi
echo "==> AppImage: $APPIMAGE ($(du -h "$APPIMAGE" | cut -f1))"

# 2. Extract the embedded squashfs
OFFSET="$(node "$REPO/scripts/appimage-offset.js" "$APPIMAGE")"
echo "==> squashfs offset: $OFFSET"
unsquashfs -q -f -o "$OFFSET" -d "$SQUASH" "$APPIMAGE" >/dev/null

# 3. Detect the Electron version the payload was built for (must match on macOS)
ELECTRON_VERSION="$(strings -a "$SQUASH/azeron-software" | grep -oE 'Electron/[0-9]+\.[0-9]+\.[0-9]+' | head -1 | cut -d/ -f2)"
[ -n "$ELECTRON_VERSION" ] || { echo "could not detect Electron version" >&2; exit 1; }
echo "==> Electron version: $ELECTRON_VERSION"

# 4. Extract app.asar and overlay the unpacked native modules
echo "==> Extracting app.asar"
npx --yes @electron/asar extract "$SQUASH/resources/app.asar" "$APPDIR"
if [ -d "$SQUASH/resources/app.asar.unpacked/node_modules" ]; then
  cp -R "$SQUASH/resources/app.asar.unpacked/node_modules/." "$APPDIR/node_modules/"
fi

# 5. Apply our macOS changes (patches + net-new files + prebuilds)
echo "==> Applying macOS changes"
node "$REPO/scripts/apply-macos-changes.js" "$APPDIR"

# 6. Stage firmware (electron-builder copies work/firmware -> Contents/MacOS/firmware)
echo "==> Staging firmware"
mkdir -p "$WORK/firmware"
cp "$SQUASH"/firmware/*.bin "$WORK/firmware/" 2>/dev/null || true
echo "    $(ls "$WORK"/firmware/*.bin 2>/dev/null | wc -l | tr -d ' ') firmware binaries"

# 7. Generate the app icon (.icns) from the bundled PNG
echo "==> Generating icon"
ICON_PNG="$(find "$SQUASH/usr/share/icons" -name '*.png' 2>/dev/null | sort -t/ -k7 -r | head -1)"
if [ -n "$ICON_PNG" ]; then
  ICONSET="$WORK/icon.iconset"; mkdir -p "$ICONSET"
  for sz in 16 32 64 128 256 512; do
    sips -z $sz $sz "$ICON_PNG" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null 2>&1 || true
    d=$((sz*2)); sips -z $d $d "$ICON_PNG" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICONSET" -o "$REPO/build/icon.icns" 2>/dev/null || true
fi
[ -f "$REPO/build/icon.icns" ] && echo "    build/icon.icns ready" || echo "    (no icon; using electron-builder default)"

# 8. Package with electron-builder (ad-hoc signed)
echo "==> Packaging with electron-builder (Electron $ELECTRON_VERSION)"
npx --yes electron-builder --mac zip --arm64 \
  --publish never \
  -c.electronVersion="$ELECTRON_VERSION" \
  -c.extraMetadata.version="$VERSION"

echo ""
echo "==> Done. Artifacts in dist/:"
ls -1 dist/*.zip 2>/dev/null || true
