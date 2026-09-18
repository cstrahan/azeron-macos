# Azeron Software for macOS

Unofficial **macOS (Apple Silicon)** repackage of the [Azeron](https://azeron.eu)
keypad configuration software. It runs the official app's own code — button
remapping, profiles, LED control, analog calibration, firmware updates, and
focus-based profile switching — on macOS, where Azeron only ships Windows and
(experimental) Linux builds.

No proprietary source is modified. The build downloads Azeron's official Linux
**AppImage**, extracts it, applies a small set of macOS compatibility shims and
patches (all in this repo), and produces a signed `.app`.

> Not affiliated with, endorsed by, or sponsored by Azeron SIA. "Azeron" is a
> trademark of Azeron SIA. Firmware binaries are property of Azeron. This is an
> interoperability repackage for personal use.

## Status

Verified working on macOS 15 (Sequoia), Apple Silicon, with an Azeron Cyborg II:

- ✅ Device detection & configuration (profiles, keybinds, LEDs, analog, mouse)
- ✅ Firmware updates (via `dfu-util`)
- ✅ Focus-based profile switching + "Active Processes" picker with app icons
- ✅ HiDPI/Retina rendering at the correct size
- ⚠️ **Apple Silicon (arm64) only** for now
- ⚠️ Ad-hoc signed (not notarized) — one-time Gatekeeper approval on first launch

> **macOS 26 (Tahoe) note:** an upstream `hidapi` issue can leave the app stuck
> on "select your device" on macOS 26.4.1+. Sequoia (15.x) is unaffected. See
> [`docs/PORTING-PLAN.md`](docs/PORTING-PLAN.md).

## Install (prebuilt)

1. Download the latest `azeron-software-*-arm64-mac.zip` from
   [Releases](https://github.com/cstrahan/azeron-macos/releases), unzip, and move
   **Azeron Software.app** to `/Applications`.
2. Because the build is ad-hoc signed, clear the quarantine flag once:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Azeron Software.app"
   ```
   (or right-click the app → **Open** → confirm).
3. For **firmware updates**, install `dfu-util`:
   ```bash
   brew install dfu-util
   ```

### Permissions

- **HID access** for device configuration works without any grant (the config
  protocol runs over a vendor-defined HID interface).
- **Firmware flashing** needs `dfu-util` on your `PATH` (Homebrew). If you launch
  from Finder and flashing can't find it, launch once from a terminal, or see
  [Known limitations](#known-limitations).
- Live keypress/heatmap features may prompt for **Input Monitoring**
  (System Settings → Privacy & Security → Input Monitoring).

## Build from source

Requirements: macOS (Apple Silicon), Xcode Command Line Tools, [Node.js](https://nodejs.org) 20+, and Homebrew.

```bash
git clone https://github.com/cstrahan/azeron-macos.git
cd azeron-macos
brew install squashfs        # provides unsquashfs
npm install
npm run build                # downloads the AppImage and builds dist/*.zip
```

Build a specific upstream version, or use a local AppImage:

```bash
npm run build -- --version 2.0.2
npm run build -- --appimage /path/to/Azeron-Software-v2.0.2.AppImage
```

The result is `dist/azeron-software-<version>-arm64-mac.zip` (and the unpacked
`.app` in `dist/mac-arm64/`).

## How it works

The Azeron app is an Electron app whose **main process is compiled to V8
bytecode** (bytenode), so it can't be edited. But the Electron entry stub, the
preload, `node_modules`, and the `@azeron/native-platform` package are all plain
JavaScript — which is where every change here lives. The pipeline
([`scripts/build-macos.sh`](scripts/build-macos.sh)):

1. **Extract** the squashfs payload from the AppImage (offset computed from the
   ELF header, so no Linux runtime needed) and unpack `app.asar`.
2. **Detect** the exact Electron version the bytecode was built for and build
   macOS against the same version.
3. **Apply macOS changes** ([`scripts/apply-macos-changes.js`](scripts/apply-macos-changes.js)),
   all as verified string patches (they fail loudly if upstream code changes) or
   net-new files:

   | Change | What / why |
   |---|---|
   | `bytecode-loader.cjs` patch | Patch the V8 **read-only-snapshot checksum** so the Linux-built bytecode loads on the macOS V8 build (same Electron version, different per-platform snapshot). |
   | `main-process.js` patch | Load our shims before the compiled main process. |
   | `macos-shims.cjs` (new) | Runtime monkey-patches: make `.app` bundles selectable in the "link a game" dialog; neutralize the Windows-centric HiDPI zoom so Retina renders correctly; hide the duplicate native traffic-light buttons. |
   | `@azeron/native-platform` macOS module (new) + `facade.js` patch | A macOS implementation of active-window detection, the running-app list, and icon extraction (koffi → `NSWorkspace`; icons via `iconForFile:` + `sharp`, because Electron's `getFileIcon` crashes on macOS). Powers focus-switching and the "Active Processes" picker. |
   | native prebuilds | Remove the stale Linux `.node` builds so the bundled macOS `usb`/`node-hid`/`koffi` prebuilds load; fetch the macOS `sharp` binaries. |

4. **Stage** firmware into `Contents/MacOS/firmware`, generate an `.icns`, and
   **package** with electron-builder (ad-hoc signed, hardened runtime).

The full design history and rationale is in
[`docs/PORTING-PLAN.md`](docs/PORTING-PLAN.md).

## Known limitations

- **Apple Silicon only.** The build targets `arm64`. Intel support would need the
  macOS x64 native prebuilds added.
- **Not notarized.** Ad-hoc signed; requires the one-time dequarantine above. A
  real Developer ID + notarization could be wired into
  [`scripts/macos-adhoc-sign.js`](scripts/macos-adhoc-sign.js) / the release
  workflow if desired.
- **`dfu-util` via Homebrew.** Firmware flashing shells out to system `dfu-util`.
  A Finder-launched app gets a minimal `PATH` without `/opt/homebrew/bin`; if
  flashing fails there, launch from a terminal or bundle a signed `dfu-util` at
  `Contents/MacOS/firmware/dfu-util-static`.
- **Auto-update is disabled** (upstream's update feed is a placeholder). New
  versions are published via this repo's [Releases](https://github.com/cstrahan/azeron-macos/releases).

## Continuous integration

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) builds the app on every
  push/PR (macOS arm64 runner) and uploads the artifact.
- [`.github/workflows/release.yml`](.github/workflows/release.yml) builds and
  publishes a GitHub Release — trigger it manually (**Actions → Release → Run
  workflow**, pick a version) or by pushing a `v*` tag.

## Credits & prior art

- [Azeron](https://azeron.eu) — the original software, hardware, and firmware.
- [renatoi/azeron-linux](https://github.com/renatoi/azeron-linux) — the Linux +
  macOS repackage of the older v1.5.6 software; its electron-builder config,
  entitlements, ad-hoc signing hook, and patch catalog were invaluable references.

## License

Unofficial repackage for personal and educational use, provided under fair use
for interoperability. The original Azeron Software is proprietary software by
Azeron SIA; firmware binaries are property of Azeron. No proprietary source code
is modified or redistributed in this repository — only build scripts, macOS
compatibility shims, and verified patches. All trademarks belong to their
respective owners. **Use at your own risk**, especially firmware updates.
