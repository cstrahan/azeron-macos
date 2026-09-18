# Porting Azeron Software v2.0.2 to macOS

Plan of record for bringing the Linux `Azeron-Software-v2.0.2.AppImage` to macOS.
Written after (a) extracting and inspecting the AppImage and (b) studying the
existing `~/src/azeron-linux` project (renatoi's unofficial repackage of the
**v1.5.6** Windows software for Linux **and macOS**). Review, annotate, and give
direction — implementation follows.

---

## 1. What the app is

The AppImage is an **Electron 40.9.2** desktop app (Chromium 144) — the Azeron
keypad/mouse configurator: profile editing, key remapping, LED control, analog
calibration, firmware flashing (DFU), and auto profile-switching by focused app.

Extraction (reproducible):

```
# squashfs payload begins right after the ELF section headers (offset 188392)
unsquashfs -o 188392 -d extracted Azeron-Software-v2.0.2.AppImage
npx @electron/asar extract extracted/resources/app.asar app_asar_extracted
```

### Layout inside the AppImage

| Path | Role | macOS action |
|------|------|--------------|
| `azeron-software` (194 MB) | Electron binary (Linux x64) | **Replace** with macOS Electron **40.9.2** |
| `resources/app.asar` | The app (renderer + preload + compiled main) | **Reuse as-is** |
| `resources/app.asar.unpacked/node_modules` | Native modules (usb, node-hid, koffi, sharp) | **Swap prebuilds** for macOS |
| `firmware/*.bin` | Device firmware images | Reuse (platform-agnostic) |
| `firmware/dfu-util-static` (Linux ELF), `*.exe` | DFU flashing tool | **Add macOS `dfu-util`** (bundle or Homebrew) |
| `linux/udev/*.rules`, `linux/scripts/*` | Linux device-permission install | **Drop** (macOS uses TCC, not udev) |
| `AppRun`, `chrome-sandbox`, `*.desktop`, `.DirIcon` | AppImage/Linux launcher plumbing | **Drop** (replaced by `.app` bundle) |
| `libEGL.so`, `*.pak`, `icudtl.dat`, `locales/` | Chromium runtime | Provided by macOS Electron build |

---

## 2. Prior art: `~/src/azeron-linux` (v1.5.6 → Linux + macOS)

This project already ships a **signed macOS arm64 build** (Homebrew cask,
hardened runtime, ad-hoc codesign) of the *older v1.5.6* software. We can reuse
its packaging recipe wholesale and mine its patch catalog for the exact
platform bugs that bite on macOS. **The single biggest difference:**

| | v1.5.6 (azeron-linux) | v2.0.2 (this port) |
|---|---|---|
| Origin | Windows installer, no official Linux/mac | Official **Linux** AppImage |
| Main process | **Plain minified `main-process.js`** → string-patchable | **Bytenode `main-process.jsc`** → *not* string-patchable |
| Cross-platform fixes | Applied by `scripts/patch-main.js` at build time | **Mostly already baked in by Azeron** (official Linux support) |
| Electron | 30.0.9 | 40.9.2 |
| node-hid | 2.2.0 (NAN, must rebuild) | 3.3.0 (N-API v4, **darwin prebuilds bundled**) |

Two consequences that reshape the plan versus my first draft:

1. **The good:** because v2.0.2 *is* the official Linux build, Azeron already
   solved the hard cross-platform device problems that renatoi had to patch in.
   The v2 bytecode's string table confirms it: `/proc/[0-9]+`, `ps`, `readlink`,
   `pkexec`, `udevadm`, `darwin`, `dfu-util`, "Falling back to system dfu-util",
   `process.resourcesPath`, `EVENT_HID_PERMISSION_ERROR`. These are exactly the
   areas renatoi had to fix by hand.
2. **The catch:** where a macOS fix *is* still needed, we **cannot edit the
   bytecode**. But the entry point `out/main/main-process.js` is a plain-JS stub
   (`require("./bytecode-loader.cjs"); require("./main-process.jsc")`) and every
   `node_modules` package is plain JS/native. That gives us a **require-time
   monkey-patch injection point**: we can wrap `node-hid`'s `HID.prototype.write`
   / `.close` / open path, `usb`, `child_process`, etc. *before* the bytecode
   runs — achieving the same effect as renatoi's source patches without touching
   the compiled code. This is the escape hatch that keeps bytecode from being a
   hard blocker for device-layer fixes.

### renatoi's patch catalog, triaged for v2.0.2 macOS

| Patch (v1.5.6) | Relevant to macOS? | Status in v2.0.2 | How we'd apply if needed |
|---|---|---|---|
| **HID write padding to 65 bytes** | **Yes — critical** | Likely already done (Linux needs it too) | require-shim wrapping `HID.prototype.write` |
| dfu-util → system `dfu-util` | Yes | Present (`darwin` fallback in strings) | bundle mac `dfu-util` / PATH |
| HID open crash → retry | Yes | Probably (official Linux support) | require-shim wrapping HID open |
| platform string `"Linux"`→`"linux"` | Maybe | Likely fixed in v2 | n/a (can't patch; verify) |
| tray-icon / app-root via `resourcesPath` | Maybe | `process.resourcesPath` present in v2 | n/a |
| disable auto-updater | Yes | Effectively disabled (placeholder URL) | leave as-is |
| setLoginItemSettings guard | **No** | macOS *supports* this API | n/a |
| Wayland scaling, USB reset, XInput drain, async writes, quit-on-close, `tasklist`→`ps`/`/proc` | Linux-only | v2 has `/proc`/`ps` paths | n/a for mac |
| **XInput Interface-0 drain** | **Possibly** — macOS also has no Xbox driver | Unknown | require-shim using bundled `usb` (mirror renatoi's IIFE) |

---

## 3. Central constraint: the main process is compiled bytecode

`out/main/main-process.jsc` (1.5 MB) is **V8 bytecode via bytenode**; we do not
have its source. Key facts:

- **We cannot edit main-process logic** — only shim around it (Section 2.2).
- **The `.jsc` is tied to the exact V8 version** *and* (per Phase 0 below) to the
  platform's V8 read-only-snapshot. It needs Electron **40.9.2** on macOS **plus a
  one-line loader patch**.

### ✅ Phase 0 RESULT (validated 2026-09-17, macOS 15.4.1 / arm64)

**The bytecode runs on macOS.** The main process fully initializes under macOS
Electron 40.9.2 — log confirms `Platform: darwin, arch: arm64, electron: 40.9.2,
node: 24.14.1`, with storage/migration/locale all working. Getting there took
three findings:

1. **V8 read-only-snapshot checksum mismatch (the real blocker).** A raw launch
   failed with `cachedDataRejected`. Diagnosis: V8's cached-data header has
   `magic[0:4]`, `version-hash[4:8]`, `source-hash[8:12]`, `flag-hash[12:16]`,
   and — added in recent V8 — a **read-only-snapshot checksum at `[16:20]`**. The
   magic, version, and flag hashes all *matched* between the Linux-built `.jsc`
   and macOS V8; only the RO-snapshot checksum differed (Linux `42 84 2c 4f` vs
   macOS `42 9d 1d 30`), because each platform's Electron build embeds its own V8
   read-only heap snapshot. bytenode's loader patches the flag hash but not this
   field. **Fix:** three lines added to `bytecode-loader.cjs`
   (`RO_SNAPSHOT_CHECKSUM_OFFSET = 16`) copying the running runtime's checksum
   into the buffer — same technique the loader already uses for the flag hash.
   After the patch, V8 accepts and correctly executes the bytecode. (Since
   `bytecode-loader.cjs` is plain JS, this is a legitimate, supported edit — not a
   bytecode modification.)
2. **Stale Linux native binaries shadowing the darwin prebuilds.** `usb` and
   `node-hid` shipped a Linux-compiled `build/Release/*.node`, which
   `node-gyp-build` prefers over `prebuilds/`. `dlopen` failed with *"slice is not
   valid mach-o file."* **Fix:** delete `usb/build` and `node-hid/build` so the
   bundled darwin prebuilds are used. (Plus add the sharp darwin packages per
   Section 4.)
3. **`ELECTRON_RUN_AS_NODE` must be unset.** With it set (it was exported in the
   dev shell), the binary runs as plain Node — `require('electron')` returns a
   path string and `app` is undefined (`Cannot read properties of undefined
   (reading 'getPath')`). Not an issue for a packaged `.app`; just unset it when
   launching in dev.

**Remaining non-blockers** surfaced by the run (all expected / Phase 1–4 work):
- Renderer loads from `http://localhost:5173` (Vite dev server →
  `ERR_CONNECTION_REFUSED`) because `app.isPackaged` is false when run unpacked.
  A real electron-builder `.app` sets `isPackaged=true` and loads the bundled
  `out/renderer/index.html`.
- Tray icon path is `src/resources/tray.ico` (Windows `.ico`); mac needs a `.png`
  laid out where the app probes — same fix renatoi applied.

### ✅ Phase 1 (packaging) RESULT (validated 2026-09-17)

**A signed macOS `.app` builds, launches, and renders the UI.** Built with
electron-builder 25 (`dev-run/` is the project; config in its `package.json`).
The packaged app logs `packaged: true`, loads the bundled renderer (all zustand
stores hydrate from IndexedDB), and shows a **1280×900 window** (confirmed via
`CGWindowListCopyWindowInfo`: `onscreen=True, alpha=1.0, layer=0`). `Loaded data
for 0 device(s)` — no keypad was connected. Findings during packaging:

1. **`ELECTRON_RUN_AS_NODE` in the environment breaks the packaged binary too** —
   it runs as plain Node and exits early (`app` undefined). Launch with it unset.
   Not an issue for normal end-user launches (Finder/Dock/`open`), only when
   invoked from a shell that exports it.
2. **electron-builder pruned real transitive deps.** Because `app/node_modules`
   was assembled from asar extraction (not a clean `npm install`), the
   production-dependency walker dropped `archiver-utils`, `color-name`,
   `color-string`, `winston-transport`, `yargs-parser` → runtime crash *Cannot
   find module 'archiver-utils'*. **Fix:** an `afterPack` hook
   (`scripts/afterpack-fill-modules.js`) rsyncs the complete `node_modules` into
   the bundle before signing. (Long-term: build the app payload from a clean
   install instead.)
3. **Packaging choices that worked:** `asar: false`, `npmRebuild: false`,
   `nodeGypRebuild: false`, `identity: null` + ad-hoc `afterSign` codesign with
   the entitlements from §8, hardened runtime, `electronVersion: 40.9.2`. Icon is
   a generated `.icns` (upscaled from the bundled 256px PNG).

**Screen-capture caveat (tooling, not the app):** automated `screencapture` from
the agent shows only the desktop because that process lacks the **Screen
Recording** TCC grant — other apps' window contents are excluded. The window is
real and visible to the user; verify visually on the physical display.

**Still open in Phase 1:** connect a real Azeron device and exercise the Input
Monitoring grant + profile read/write (needs hardware + user consent); tray icon
(`.ico`→`.png`) polish.

---

## 4. Native-module inventory (the real porting surface)

| Module | Version | macOS prebuild bundled? | Action |
|--------|---------|-------------------------|--------|
| `usb` | 2.17.0 | ✅ `darwin-x64+arm64` | Reuse — works out of the box |
| `node-hid` | 3.3.0 | ✅ `HID-darwin-arm64`, `HID-darwin-x64` (N-API v4) | Reuse (no rebuild — unlike v1.5.6's 2.2.0) |
| `koffi` | 2.16.2 | ✅ `darwin_arm64`, `darwin_x64` | Reuse |
| `sharp` | 0.34.5 | ❌ **Linux only** | **Add** `@img/sharp-darwin-{arm64,x64}` + `sharp-libvips-darwin-*` |

Three of four already carry macOS binaries — they were built multi-platform and
simply never exercised on the Linux target. Only **sharp** (profile
icon/background processing) needs its macOS variant added via `npm`.

---

## 5. `@azeron/native-platform` — needs a macOS implementation

Pure-JS koffi-FFI package powering "focus switching" / the process picker. Its
`dist/facade.js` branches only on `win32`/`linux`; **no `darwin` branch**, so on
macOS every entry point returns `null`/`[]`/empty. The app still runs — those
features are just dead. Because it's **plain, editable JS**, we add macOS support:

- New `dist/macos/platform.macos.js` implementing `getActiveWindow`,
  `getProcessList`, `extractHighResIcon`, `extractIconPNG`,
  `extractMultipleIcons`, `buildIconMap`, `resolveProcessIcons`; wire `darwin`
  into `facade.js`.
- Building blocks: frontmost app via `NSWorkspace`/`CGWindowList` (koffi has a
  darwin lib), process list via `NSWorkspace.runningApplications` or `ps`/libproc,
  icons via `.app/Contents/Resources/*.icns` → PNG with the already-present `sharp`.
- Note the TCC nuance: window *titles* of other apps need **Screen Recording**
  permission; frontmost bundle id/name does not. Scope accordingly.

**Optional for a first runnable build** — see Decisions (ship core config first,
add this later, or up front).

---

## 6. Device access on macOS

- **HID (Azeron, USB vendor `0x16d0`):** node-hid uses IOKit `IOHIDManager`; no
  kext/udev. macOS 10.15+ requires the user to grant **Input Monitoring** (TCC)
  before the app can read HID. The app already has an `EVENT_HID_PERMISSION_ERROR`
  channel to surface this. A signed bundle (even ad-hoc, hardened runtime +
  entitlements + sealed resources) gives TCC a stable identity to bind the grant
  to — renatoi found this matters.
- **HID write padding (critical to verify):** IOKit's `IOHIDDeviceSetReport`
  does **not** auto-pad short writes like the Windows driver does; the Azeron
  ignores short reports. renatoi pads to 65 bytes on **both linux and darwin**.
  v2.0.2 almost certainly already pads (Linux needs it too), but if a connected
  device opens yet never responds, apply the padding via a `HID.prototype.write`
  require-shim.
- **DFU bootloader (STM32 `0x0483:0xdf11`):** libusb (`usb` module) works in
  userspace via IOKit; the DFU interface isn't claimed by any driver, so **no
  driver install needed** (unlike Windows WinUSB). v2's main process already
  treats driver install as Windows-only.
- **⚠ macOS 26 (Tahoe) hidapi showstopper:** on macOS 26.4.1+, the app can open
  the HID interface and write, but `hidapi`'s input-report callback never
  delivers reports to userspace → stuck on "select your device" (affects node-hid
  2.x *and* 3.x; needs an upstream `hidapi-mac` fix). **This machine is Darwin
  24.4.0 = macOS 15 Sequoia, so it is *not* affected** — but any distributable
  build must document it and gate/warn on macOS 26+.
- **udev:** dropped entirely on macOS; the `install-udev-rules`/`check-udev-rules`
  IPC handlers are no-ops off Linux.

---

## 7. Firmware flashing (`dfu-util`)

Firmware `.bin` files are reused. Only a Linux ELF `dfu-util-static` + Windows
`.exe` ship; the v2 darwin path expects to copy a bundled `dfu-util` to a
writable location, `chmod +x` it, and fall back to a system `dfu-util`. Options:

1. **Bundle a signed universal macOS `dfu-util`** in `firmware/` (self-contained;
   preferred). Source: build dfu-util 0.11 or repackage the Homebrew binary; sign
   with the app.
2. **Depend on Homebrew `dfu-util`** on `PATH` (uses the documented fallback;
   what azeron-linux does — `brew install dfu-util`).

Phase 1 will trace the **exact filename/path** the darwin branch probes using
`AZERON_DEBUG=1` (the app honors it) before we bundle.

---

## 8. Packaging & signing — adapt azeron-linux's recipe directly

renatoi's `package.json` `build.mac`, `build/entitlements.mac.plist`, and
`scripts/macos-adhoc-sign.js` are a working template. Concretely, for v2.0.2:

- **electron-builder `mac` target** (`dmg` + `zip`), `appId: com.azeron.software`
  (matches the string in the v2 bytecode), `category:
  public.app-category.utilities`, `hardenedRuntime: true`, `gatekeeperAssess:
  false`, `identity: null` for ad-hoc (or a Developer ID for real distribution).
- **`asarUnpack`** must cover v2's native set:
  `node-hid`, `usb`, `koffi`, `sharp`, `@img/*`, `@azeron/native-platform`.
  (Or keep the app **unpacked** as it already is inside the AppImage and skip asar
  repacking entirely — simplest, avoids re-asaring the bytecode.)
- **`extraFiles`**: `firmware/**` (+ bundled `dfu-util` if chosen); tray icon.
- **Entitlements** (from azeron-linux, all needed here):
  `com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`,
  `allow-dyld-environment-variables`, `cs.disable-library-validation` (native
  addons carry their own ad-hoc sigs), `device.usb`, `device.bluetooth`.
- **`afterSign` ad-hoc codesign hook** (`macos-adhoc-sign.js`): `codesign --force
  --deep --options runtime --identifier com.azeron.software --entitlements … --sign
  -`. Gives TCC a stable identity even without a Developer ID.
- **Info.plist:** bundle id, category, tray/`LSUIElement` parity as desired.
- **Auto-update:** leave disabled (`app-update.yml` is a placeholder URL).
- **Distribution:** Homebrew cask like `Casks/azeron-software.rb` (arm64,
  `depends_on macos: ">= :sonoma"`); first-launch requires dequarantine
  (`xattr -d com.apple.quarantine …`) or right-click→Open unless notarized.

---

## 9. Phased plan

### Phase 0 — Validate the bytecode loads on macOS *(gating)*
1. `npm i electron@40.9.2` (macOS arm64).
2. Assemble a run dir from the extracted app (unpacked node_modules with macOS
   prebuilds swapped in; add `@img/sharp-darwin-*`).
3. Launch; confirm `main-process.jsc` loads without `cachedDataRejected`.
   **If it rejects → approach blocked; escalate to Azeron for source/mac build.**

### Phase 1 — Minimal runnable app (core device config)
1. Swap macOS native prebuilds; add sharp darwin packages.
2. Window renders; connect a device over HID; verify Input Monitoring flow and
   basic profile read/write. **If device opens but never responds → apply
   HID-padding require-shim** (Section 6).
3. Trace darwin `dfu-util` lookup with `AZERON_DEBUG=1`.

### Phase 2 — Firmware flashing
1. Bundle (or wire up Homebrew) macOS `dfu-util`; verify DFU enum via libusb.
2. End-to-end flash on a real device (reversible test firmware).

### Phase 3 — Focus-switching / process features (optional for v1)
1. Implement `dist/macos/platform.macos.js`; wire `darwin` into `facade.js`.
2. Verify active-window detection, process picker, icon extraction; decide Screen
   Recording scope.

### Phase 4 — Packaging & signing
1. Adapt azeron-linux's electron-builder mac config, entitlements, adhoc-sign hook.
2. Produce `.dmg`/`.zip`; (optionally) Developer ID + notarize.
3. Smoke-test on a clean macOS machine (Sequoia; warn on Tahoe).

---

## 10. Decisions

**Locked in:**

- ✅ **Feature scope for v1:** **Core device config first** (HID connect,
  profiles, LED, calibration, firmware flashing). Focus-switching / process
  picker (Section 5, the `dist/macos/platform.macos.js` work) is deferred to a
  later pass — the app runs fine without it.
- ✅ **Distribution:** **Ad-hoc signed for local use** — hardened runtime +
  entitlements + ad-hoc codesign (azeron-linux's approach). No Apple Developer
  account. First launch needs dequarantine / right-click→Open.
- ✅ **`dfu-util`:** **Homebrew dependency** — rely on `brew install dfu-util` on
  `PATH` via the app's documented system-`dfu-util` fallback. No binary to bundle
  or sign for v1.

**Defaults chosen (flag if you disagree):**

- **Architecture:** Apple Silicon (`arm64`) only — matches this machine (Sequoia
  arm64) and azeron-linux. Universal can come later.
- **Packaging:** keep the app directory **unpacked** as the AppImage already
  ships it (no re-asaring the bytecode) — simplest and lowest-risk.

**Still open:**

- **Source access:** any chance Azeron shares main-process source? It would
  remove the bytecode constraint and every "can't patch the main process" caveat.

---

## 11. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| ~~`.jsc` won't load on macOS Electron 40.9.2~~ | — | ~~Blocking~~ | ✅ **RESOLVED in Phase 0** — RO-snapshot-checksum loader patch; bytecode runs |
| HID device opens but never responds (padding or macOS 26 Tahoe bug) | Med | High | Padding require-shim; **verify OS < macOS 26** (this box is Sequoia ✓); warn on Tahoe |
| A needed macOS fix lives only in bytecode (can't shim it) | Low | Feature-scoped | v2 has darwin/Linux paths already; shim device layer; escalate to Azeron |
| Input Monitoring not granted → confusing UX | High | Med | Signed bundle + `hid-permission-error` event + docs |
| macOS `dfu-util` path/name mismatch vs. what main process probes | Med | Med | Trace with `AZERON_DEBUG` before bundling |
| XInput Interface-0 lockup on macOS (no Xbox driver) | Low–Med | Med | Mirror renatoi's `usb`-based drain via require-shim if observed |
| Signing/notarization friction (USB/JIT entitlements) | Low | Med | Reuse azeron-linux's proven entitlements + adhoc-sign hook |

---

### ✅ Phase 2 (firmware flashing) RESULT (verified 2026-09-17)

**Firmware flashing works end-to-end on macOS through the app.** Flashed the
connected Cyborg II from v110 → v111; device re-enumerated at `bcdDevice 1.11`
and the app dropped out of read-only mode (`Profile … saved successfully`). No
brick, clean `dfu-util close, code: 0`.

Exact behavior observed (authoritative for packaging):

- **DFU entry:** app sends `Send DFU mode` (HID command) + prompts a physical
  pin-reset; device re-enumerates as STM32 `0483:df11`. All four alt settings
  enumerate on macOS with no kext/permission (alt 0 = `@Internal Flash
  /0x08000000`).
- **`dfu-util` resolution:** app first looks for a bundled
  `<execDir>/firmware/dfu-util-static`; when absent it **falls back to system
  `dfu-util` via `PATH`** and used `/opt/homebrew/bin/dfu-util` (brew, v0.11).
  It runs `dfu-util -l`, parses the alt table, selects the internal-flash target,
  then downloads the image.
- **Exact bundle paths** (both relative to `dirname(process.execPath)` =
  `<App>.app/Contents/MacOS/`, mirroring the AppImage's `APPDIR/firmware`):
  - firmware binaries → **`Contents/MacOS/firmware/azeron-fw-<model>-<ver>.bin`**
    (Cyborg II = `cyborg-v2`; `-p-` = performance variant)
  - optional bundled flasher → `Contents/MacOS/firmware/dfu-util-static`
  - electron-builder: `extraFiles` `to: "MacOS/firmware"` (was `firmware`, which
    landed one level too high in `Contents/` and caused *Firmware binary not
    found* on the first attempt).

**Remaining distribution caveat (`dfu-util` on `PATH`):** the system-`dfu-util`
fallback only works because we launch from a terminal that has `/opt/homebrew/bin`
on `PATH`. A **Finder/Dock-launched** `.app` gets a minimal `PATH` without
Homebrew, so firmware flashing would fail for end users. Options for a shipping
build: (a) bundle a self-contained macOS `dfu-util` at
`Contents/MacOS/firmware/dfu-util-static` (needs libusb bundled or static-linked
+ signed), or (b) document `brew install dfu-util` and have the app search
`/opt/homebrew/bin` / `/usr/local/bin` explicitly. Not needed for local dev use.

## Appendix — device reference (Azeron Cyborg II, captured 2026-09-17)

- **USB:** VID `0x16d0`, PID `0x12f7`, serial `2061358D4256`, manufacturer
  "Azeron LTD", `bcdDevice 1.10` (= firmware v110). DFU bootloader (flashing mode)
  is STM32 `0x0483:0xdf11`.
- **HID interfaces** (macOS node-hid enumeration; paths are opaque `DevSrvsID:<n>`):
  - iface 1 — keyboard (`usagePage 0x01/usage 0x06`) + consumer (`0x0C/0x01`)
  - iface 2 — mouse (`0x01/0x02`)
  - iface 3 — joystick/gamepad (`0x01/0x04`, `0x01/0x01`)
  - **iface 4 — vendor config (`usagePage 0xFF01/usage 0x0101`)** ← the protocol
    interface the app uses; **openable on macOS without Input Monitoring** because
    it is vendor-defined, not a keyboard. Firmware-version read confirmed working.
- **macOS HID path quirk:** node-hid returns `DevSrvsID:<n>` with no embedded
  VID/PID, so the app's path→PID regex fails (`PID pattern not found in
  DevSrvsID:…`). Live detection uses the `productId` field and works; only a
  stored-device *migration* path was affected. Cyborg II firmware family =
  `azeron-fw-cyborg-v2-*.bin` (v111 available in `firmware/`).

## Appendix — key evidence

- Electron version: `strings extracted/azeron-software | grep Electron` → `Chrome/144.0.7559.236 Electron/40.9.2`.
- Bytecode loader: `app_asar_extracted/out/main/bytecode-loader.cjs`.
- macOS awareness in v2 main process: `strings app_asar_extracted/out/main/main-process.jsc | grep -iE 'darwin|dfu-util|/proc|resourcesPath'`.
- Native prebuilds: `extracted/resources/app.asar.unpacked/node_modules/{usb/prebuilds,node-hid/prebuilds,koffi/build/koffi}`.
- Platform dispatch (editable): `.../@azeron/native-platform/dist/facade.js`.
- IPC surface: `app_asar_extracted/out/preload/preload.js`.
- Prior-art recipe: `~/src/azeron-linux/{package.json, build/entitlements.mac.plist, scripts/macos-adhoc-sign.js, scripts/setup-macos.sh, scripts/patch-main.js, Casks/azeron-software.rb}`.
</content>
