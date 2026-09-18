"use strict";
// macOS implementation of the native-platform surface.
//
// Active-window detection and the running-process list use a small koffi bridge
// to the Objective-C runtime (NSWorkspace / NSRunningApplication) — in-process,
// no subprocess per poll, and no Accessibility/Screen-Recording TCC prompt
// (frontmostApplication + runningApplications + activationPolicy need no grant).
//
// Icon extraction ALSO goes through the koffi bridge — NSWorkspace iconForFile:
// → NSBitmapImageRep → PNG — then downscales with sharp. Electron's
// app.getFileIcon() is deliberately NOT used: on macOS (Electron 40.x) it
// hard-crashes the process (EXC_BREAKPOINT/SIGTRAP) in its NSImage→gfx glue.
//
// Focus subscription is intentionally NOT implemented here — the facade leaves
// subscribeActiveWindow() returning false on macOS, so the app polls
// getActiveWindow() on its monitoring interval (same model as Linux).
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildIconMap = exports.resolveProcessIcons = exports.isValidProcessPath = exports.getProcessListFiltered = exports.getProcessList = exports.extractIconPNG = exports.extractMultipleIcons = exports.extractHighResIcon = exports.getActiveWindow = void 0;
const logger_1 = require("../logger");

let sharp = null;
try {
    sharp = require("sharp");
}
catch {
    /* sharp missing → fall back to full-size icons */
}

const ICON_SIZE = 128;

// ─── Objective-C bridge (lazy, memoized, fail-safe) ─────────────────
let bridge = null; // null = not tried, false = failed, object = ready
function objc() {
    if (bridge !== null)
        return bridge || null;
    try {
        const koffi = require("koffi");
        koffi.load("/System/Library/Frameworks/Foundation.framework/Foundation");
        koffi.load("/System/Library/Frameworks/AppKit.framework/AppKit");
        const lib = koffi.load("/usr/lib/libobjc.A.dylib");
        const getClass = lib.func("void* objc_getClass(const char*)");
        const selReg = lib.func("void* sel_registerName(const char*)");
        const poolPush = lib.func("void* objc_autoreleasePoolPush()");
        const poolPop = lib.func("void objc_autoreleasePoolPop(void*)");
        // Typed aliases of the variadic objc_msgSend (koffi permits multiple).
        const msgId = lib.func("objc_msgSend", "void*", ["void*", "void*"]);
        const msgStr = lib.func("objc_msgSend", "str", ["void*", "void*"]);
        const msgI32 = lib.func("objc_msgSend", "int32", ["void*", "void*"]);
        const msgU64 = lib.func("objc_msgSend", "uint64", ["void*", "void*"]);
        const msgIdU64 = lib.func("objc_msgSend", "void*", ["void*", "void*", "uint64"]);
        const msgIdStr = lib.func("objc_msgSend", "void*", ["void*", "void*", "str"]);
        const msgIdPtr = lib.func("objc_msgSend", "void*", ["void*", "void*", "void*"]);
        const msgIdU64Ptr = lib.func("objc_msgSend", "void*", ["void*", "void*", "uint64", "void*"]);
        const selCache = new Map();
        const sel = (name) => {
            let s = selCache.get(name);
            if (!s) {
                s = selReg(name);
                selCache.set(name, s);
            }
            return s;
        };
        const clsCache = new Map();
        const cls = (name) => {
            let c = clsCache.get(name);
            if (!c) {
                c = getClass(name);
                clsCache.set(name, c);
            }
            return c;
        };
        const str = (nsstring) => (nsstring ? msgStr(nsstring, sel("UTF8String")) : null);
        const urlPath = (url) => (url ? str(msgId(url, sel("path"))) : null);
        // NSWorkspace iconForFile: → NSBitmapImageRep → PNG bytes (raw Buffer).
        const iconPng = (path) => {
            if (!path)
                return null;
            const nsPath = msgIdStr(cls("NSString"), sel("stringWithUTF8String:"), path);
            const ws = msgId(cls("NSWorkspace"), sel("sharedWorkspace"));
            const icon = msgIdPtr(ws, sel("iconForFile:"), nsPath);
            if (!icon)
                return null;
            const tiff = msgId(icon, sel("TIFFRepresentation"));
            if (!tiff)
                return null;
            const rep = msgIdPtr(cls("NSBitmapImageRep"), sel("imageRepWithData:"), tiff);
            if (!rep)
                return null;
            // NSBitmapImageFileTypePNG = 4, properties = nil
            const png = msgIdU64Ptr(rep, sel("representationUsingType:properties:"), 4, null);
            if (!png)
                return null;
            const len = Number(msgU64(png, sel("length")));
            const bytesPtr = msgId(png, sel("bytes"));
            if (!bytesPtr || !len)
                return null;
            return Buffer.from(koffi.decode(bytesPtr, koffi.array("uint8", len)));
        };
        bridge = { cls, sel, msgId, msgI32, msgU64, msgIdU64, str, urlPath, iconPng, poolPush, poolPop };
        return bridge;
    }
    catch (err) {
        (0, logger_1.safeLog)("ERROR", "macOS native bridge init failed; active-window/process features disabled", false, `${err}`);
        bridge = false;
        return null;
    }
}

function readRunningApp(b, appPtr) {
    if (!appPtr)
        return null;
    const name = b.str(b.msgId(appPtr, b.sel("localizedName")));
    const pid = b.msgI32(appPtr, b.sel("processIdentifier"));
    let path = b.urlPath(b.msgId(appPtr, b.sel("bundleURL")));
    if (!path)
        path = b.urlPath(b.msgId(appPtr, b.sel("executableURL")));
    const bundleId = b.str(b.msgId(appPtr, b.sel("bundleIdentifier")));
    return { name: name || "", pid: pid | 0, path: path || "", bundleId: bundleId || "" };
}

// Full-size PNG (via koffi), downscaled to ICON_SIZE with sharp when available.
async function iconPngResized(path) {
    const b = objc();
    if (!b)
        return null;
    let raw;
    const pool = b.poolPush();
    try {
        raw = b.iconPng(path);
    }
    catch (err) {
        (0, logger_1.safeLog)("DEBUG", `macOS iconForFile failed for ${path}: ${err}`, false);
        raw = null;
    }
    finally {
        b.poolPop(pool);
    }
    if (!raw || raw.length === 0)
        return null;
    if (sharp) {
        try {
            return await sharp(raw)
                .resize(ICON_SIZE, ICON_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png()
                .toBuffer();
        }
        catch {
            /* fall through to full-size */
        }
    }
    return raw;
}
const toDataUrl = (buf) => (buf ? `data:image/png;base64,${buf.toString("base64")}` : null);

// ─── Active window ──────────────────────────────────────────────────
let macActiveWindowLogged = false;
const getActiveWindow = async () => {
    const b = objc();
    if (!b)
        return null;
    const pool = b.poolPush();
    try {
        const ws = b.msgId(b.cls("NSWorkspace"), b.sel("sharedWorkspace"));
        const front = b.msgId(ws, b.sel("frontmostApplication"));
        const info = readRunningApp(b, front);
        if (!info)
            return null;
        if (!macActiveWindowLogged) {
            macActiveWindowLogged = true;
            (0, logger_1.safeLog)("INFO", `macOS active window detection active (NSWorkspace). First focus: "${info.name}" [${info.bundleId}] path="${info.path}"`, false);
        }
        return {
            title: info.name,
            id: info.pid,
            bounds: { x: 0, y: 0, width: 0, height: 0 },
            owner: { name: info.name, processId: info.pid, path: info.path },
            memoryUsage: 0,
            wmClass: info.bundleId,
        };
    }
    catch (err) {
        (0, logger_1.safeLog)("DEBUG", `macOS getActiveWindow failed: ${err}`, false);
        return null;
    }
    finally {
        b.poolPop(pool);
    }
};
exports.getActiveWindow = getActiveWindow;

// ─── Process list ───────────────────────────────────────────────────
const getProcessList = async () => {
    const b = objc();
    if (!b)
        return [];
    const pool = b.poolPush();
    try {
        const ws = b.msgId(b.cls("NSWorkspace"), b.sel("sharedWorkspace"));
        const apps = b.msgId(ws, b.sel("runningApplications"));
        const count = Number(b.msgU64(apps, b.sel("count")));
        const results = [];
        const seen = new Set();
        for (let i = 0; i < count; i++) {
            const appPtr = b.msgIdU64(apps, b.sel("objectAtIndex:"), i);
            if (b.msgI32(appPtr, b.sel("activationPolicy")) !== 0)
                continue; // regular GUI apps only
            const info = readRunningApp(b, appPtr);
            if (!info || !info.path || seen.has(info.path))
                continue;
            seen.add(info.path);
            results.push({ Name: info.name, Path: info.path });
        }
        return results;
    }
    catch (err) {
        (0, logger_1.safeLog)("ERROR", `macOS getProcessList failed`, false, `${err}`);
        return [];
    }
    finally {
        b.poolPop(pool);
    }
};
exports.getProcessList = getProcessList;
const getProcessListFiltered = async () => (0, exports.getProcessList)();
exports.getProcessListFiltered = getProcessListFiltered;

// ─── Icon extraction (koffi NSWorkspace iconForFile: + sharp) ───────
const extractHighResIcon = async (exePath) => {
    try {
        return toDataUrl(await iconPngResized(exePath));
    }
    catch (error) {
        (0, logger_1.safeLog)("WARNING", `Failed to extract icon for ${exePath}`, false, `${error}`);
        return null;
    }
};
exports.extractHighResIcon = extractHighResIcon;

const extractIconPNG = async (filePath) => {
    try {
        const buf = await iconPngResized(filePath);
        if (buf)
            return { icon: buf };
    }
    catch (error) {
        (0, logger_1.safeLog)("ERROR", `Failed to extract icon for ${filePath}`, false, `${error}`);
    }
    return { icon: Buffer.from([]) };
};
exports.extractIconPNG = extractIconPNG;

const extractMultipleIcons = async (executablePaths) => {
    const results = {};
    for (const p of executablePaths) {
        if (!p)
            continue;
        const url = toDataUrl(await iconPngResized(p));
        if (url)
            results[p] = url;
    }
    return results;
};
exports.extractMultipleIcons = extractMultipleIcons;

const resolveProcessIcons = async (processes) => {
    const icons = {};
    for (const proc of processes) {
        if (!proc || !proc.path)
            continue;
        const url = toDataUrl(await iconPngResized(proc.path));
        if (url)
            icons[proc.path] = url;
    }
    return icons;
};
exports.resolveProcessIcons = resolveProcessIcons;

const buildIconMap = async () => new Map();
exports.buildIconMap = buildIconMap;

// ─── Path validation ────────────────────────────────────────────────
const isValidProcessPath = (pathStr) => typeof pathStr === "string" && pathStr.startsWith("/");
exports.isValidProcessPath = isValidProcessPath;
