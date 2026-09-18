"use strict";
// macOS runtime shims applied before the (compiled) main process runs.
//
// The main process is bytenode bytecode we can't edit, but this stub is plain
// JS, so we monkey-patch Electron APIs here to fix macOS-specific behavior that
// the Windows/Linux-oriented bytecode gets wrong.
//
// Shim 1 — file picker for "link a game/app":
//   The bytecode opens dialog.showOpenDialog with a Windows/Linux filter
//   ({name:"Executable Files", extensions:["exe","url",...]}). On macOS that
//   greys out .app bundles. When we detect exactly that filter, we swap in
//   macOS-appropriate filters so .app bundles (and any file) are selectable.
//   All other dialogs (JSON/zip/image imports) are left untouched.

if (process.platform === "darwin") {
    // Shim 2 — HiDPI scaling.
    //   The app derives BOTH a window zoom (≈ 1/scaleFactor) and its theme
    //   uiScale from the display's scaleFactor. On a Retina Mac scaleFactor is 2,
    //   so it applies a 0.5 zoom (halving the UI and collapsing devicePixelRatio
    //   to 1 — losing Retina crispness) while over-inflating uiScale. That nets
    //   out to a too-small, non-crisp UI.
    //
    //   Fix: make the app perceive every display as scaleFactor = 1 (a normal
    //   Windows-100%-style display). Chromium still renders at the true Retina
    //   backing scale (the JS `screen` module is informational and does not
    //   change actual rendering), so the UI is both correctly sized AND crisp.
    try {
        const electron = require("electron");
        const applyScreenShim = () => {
            const screen = electron.screen;
            if (!screen || screen.__azeronScaleShim) return;
            const fix = (d) => (d && typeof d.scaleFactor === "number" && d.scaleFactor !== 1
                ? Object.assign({}, d, { scaleFactor: 1 })
                : d);
            for (const m of ["getPrimaryDisplay", "getDisplayNearestPoint", "getDisplayMatching"]) {
                const orig = screen[m];
                if (typeof orig !== "function") continue;
                screen[m] = function (...args) { return fix(orig.apply(this, args)); };
            }
            const origAll = screen.getAllDisplays;
            if (typeof origAll === "function") {
                screen.getAllDisplays = function (...args) {
                    const arr = origAll.apply(this, args);
                    return Array.isArray(arr) ? arr.map(fix) : arr;
                };
            }
            screen.__azeronScaleShim = true;
        };
        // `screen` is only usable once the app is ready; wrap as early as
        // possible so it is in place before the first window is created.
        if (electron.app.isReady()) applyScreenShim();
        else electron.app.once("ready", applyScreenShim);

        // Shim 3 — native traffic-light buttons.
        //   The window uses titleBarStyle "hidden", which on macOS still shows
        //   the native close/minimize/zoom buttons over the content. The app
        //   draws its own window controls, so hide the native ones.
        electron.app.on("browser-window-created", (_event, win) => {
            try {
                if (typeof win.setWindowButtonVisibility === "function") {
                    win.setWindowButtonVisibility(false);
                }
            } catch {
                /* best effort */
            }
        });

        const dialog = electron.dialog;

        const isExecutableFilter = (options) =>
            options &&
            Array.isArray(options.filters) &&
            options.filters.some(
                (f) =>
                    f &&
                    Array.isArray(f.extensions) &&
                    f.extensions.some((e) => /^(exe|url|lnk)$/i.test(String(e)))
            );

        const patchExecutablePicker = (options) => {
            if (!isExecutableFilter(options)) return options;
            options.filters = [
                { name: "Applications", extensions: ["app"] },
                { name: "All Files", extensions: ["*"] },
            ];
            if (Array.isArray(options.properties)) {
                // Keep it a file picker; .app packages are selectable as files.
                options.properties = options.properties.filter((p) => p !== "openDirectory");
                if (!options.properties.includes("openFile")) options.properties.push("openFile");
            }
            return options;
        };

        for (const name of ["showOpenDialog", "showOpenDialogSync"]) {
            const orig = dialog && dialog[name];
            if (typeof orig !== "function") continue;
            dialog[name] = function (...args) {
                // Signature is (options) or (browserWindow, options); options is
                // always the last argument. patchExecutablePicker is a no-op
                // unless it is the exe/url "link a game" dialog.
                const last = args[args.length - 1];
                if (last && typeof last === "object") patchExecutablePicker(last);
                return orig.apply(this, args);
            };
        }
    } catch (err) {
        // Never let a shim failure take down the app.
        try {
            process.stderr.write(`[macos-shims] dialog shim failed: ${err}\n`);
        } catch {}
    }
}
