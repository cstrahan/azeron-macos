#!/usr/bin/env node
"use strict";
/**
 * apply-macos-changes.js <appDir>
 *
 * Turns a freshly-extracted Azeron `app` directory (the contents of the Linux
 * AppImage's resources/app.asar, with resources/app.asar.unpacked/node_modules
 * overlaid on top) into a macOS-ready app payload.
 *
 * It performs, all idempotently and with loud failure if the upstream code has
 * changed out from under a patch:
 *   1. bytecode-loader.cjs  — patch in the V8 read-only-snapshot checksum fix
 *   2. main-process.js      — load our macOS shims before the compiled main
 *   3. macos-shims.cjs      — install our runtime shims (net-new file)
 *   4. native-platform      — install the macOS platform module (net-new) and
 *                             wire darwin branches into facade.js
 *   5. native prebuilds     — drop stale Linux .node builds; add sharp/darwin
 *
 * Everything net-new lives in ../src; everything patched is upstream code that
 * is only ever edited via verified string replacement.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SRC = path.join(REPO, "src");

const appDir = process.argv[2];
if (!appDir) {
  console.error("usage: apply-macos-changes.js <appDir>");
  process.exit(1);
}
const abs = (...p) => path.join(appDir, ...p);

let changed = 0;
const log = (m) => console.log(`  ${m}`);

/** Verified string replacement. Throws if `search` is absent (unless already applied). */
function patchFile(file, name, search, replace) {
  let code = fs.readFileSync(file, "utf8");
  if (code.includes(replace) && !code.includes(search)) {
    log(`patch "${name}": already applied`);
    return;
  }
  if (!code.includes(search)) {
    throw new Error(
      `patch "${name}" FAILED: search string not found in ${path.relative(appDir, file)} — ` +
        `the upstream file likely changed and this port needs review.\n  looking for: ${search.slice(0, 80)}...`
    );
  }
  const count = code.split(search).length - 1;
  if (count > 1) throw new Error(`patch "${name}": search string is ambiguous (${count}×)`);
  fs.writeFileSync(file, code.split(search).join(replace));
  log(`patch "${name}": applied`);
  changed++;
}

function copyIn(srcFile, destFile, name) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.copyFileSync(srcFile, destFile);
  log(`install "${name}"`);
  changed++;
}

// ─── 1. bytecode-loader.cjs: V8 read-only-snapshot checksum ──────────
(() => {
  const f = abs("out/main/bytecode-loader.cjs");
  let code = fs.readFileSync(f, "utf8");
  // 1a. declare the offset next to the other header offsets
  patchFile(
    f,
    "loader/ro-snapshot-const",
    "const SOURCE_HASH_OFFSET = 8;\n",
    "const SOURCE_HASH_OFFSET = 8;\nconst RO_SNAPSHOT_CHECKSUM_OFFSET = 16; // macOS port: V8 read-only-snapshot checksum\n"
  );
  // 1b. copy the running runtime's checksum into the buffer (same technique as flag hash)
  patchFile(
    f,
    "loader/ro-snapshot-copy",
    "  dummyBytecode.slice(FLAG_HASH_OFFSET, FLAG_HASH_OFFSET + 4).copy(bytecodeBuffer, FLAG_HASH_OFFSET);\n};",
    "  dummyBytecode.slice(FLAG_HASH_OFFSET, FLAG_HASH_OFFSET + 4).copy(bytecodeBuffer, FLAG_HASH_OFFSET);\n" +
      "  // macOS port: the Linux-built .jsc carries the Linux V8 read-only snapshot\n" +
      "  // checksum, which the macOS V8 build rejects. Overwrite it with the running\n" +
      "  // runtime's checksum so V8's sanity check passes.\n" +
      "  dummyBytecode.slice(RO_SNAPSHOT_CHECKSUM_OFFSET, RO_SNAPSHOT_CHECKSUM_OFFSET + 4).copy(bytecodeBuffer, RO_SNAPSHOT_CHECKSUM_OFFSET);\n};"
  );
  void code;
})();

// ─── 2. main-process.js: load our shims before the compiled main ────
patchFile(
  abs("out/main/main-process.js"),
  "main/require-shims",
  'require("./bytecode-loader.cjs");\n',
  'require("./bytecode-loader.cjs");\nrequire("./macos-shims.cjs");\n'
);

// ─── 3. macos-shims.cjs (net-new) ───────────────────────────────────
copyIn(path.join(SRC, "main/macos-shims.cjs"), abs("out/main/macos-shims.cjs"), "out/main/macos-shims.cjs");

// ─── 4. native-platform macOS module + facade wiring ────────────────
const NP = "node_modules/@azeron/native-platform/dist";
copyIn(
  path.join(SRC, "native-platform/platform.macos.js"),
  abs(NP, "macos/platform.macos.js"),
  "native-platform/macos/platform.macos.js"
);
(() => {
  const f = abs(NP, "facade.js");
  // 4a. isMac constant
  patchFile(
    f,
    "facade/isMac",
    'const isLinux = process.platform === "linux";\n',
    'const isLinux = process.platform === "linux";\nconst isMac = process.platform === "darwin";\n'
  );
  const mac = (fn) =>
    `    if (isMac)\n        return (await Promise.resolve().then(() => __importStar(require("./macos/platform.macos")))).${fn};\n`;
  const linux = (fn) =>
    `        return (await Promise.resolve().then(() => __importStar(require("./linux/platform.linux")))).${fn};\n`;
  // 4b. one branch per facade entry point. Each `search` is the upstream
  //     Linux branch + its default-return tail (kept unique per function);
  //     each `replace` inserts the macOS branch between them.
  const branches = [
    ["getActiveWindow", "getActiveWindow()", "    return null;"],
    ["extractHighResIcon", "extractHighResIcon(exePath)", "    return null;"],
    ["extractIconPNG", "extractIconPNG(filePath)", "    return { icon: Buffer.from([]) };"],
    ["extractMultipleIcons", "extractMultipleIcons(executablePaths)", "    return {};"],
    ["getProcessList", "getProcessList()", "    return [];\n};\nexports.getProcessList = getProcessList;"],
    ["getProcessListFiltered", "getProcessList()", "    return [];\n};\nexports.getProcessListFiltered = getProcessListFiltered;"],
    ["buildIconMap", "buildIconMap()", "    return new Map();"],
    ["resolveProcessIcons", "resolveProcessIcons(processes)", "    return {};"],
  ];
  for (const [name, macFn, tail] of branches) {
    const search = linux(macFn) + tail;
    const replace = linux(macFn) + mac(macFn) + tail;
    patchFile(f, `facade/${name}`, search, replace);
  }
  // 4c. isValidProcessPath (synchronous; different shape)
  patchFile(
    f,
    "facade/isValidProcessPath",
    "        return pathStr.startsWith(\"/\") || isWindowsStyleExePath(pathStr);\n    return false;",
    "        return pathStr.startsWith(\"/\") || isWindowsStyleExePath(pathStr);\n    if (isMac)\n        return typeof pathStr === \"string\" && pathStr.startsWith(\"/\");\n    return false;"
  );
})();

// ─── 5. native prebuilds: drop stale Linux builds, add sharp/darwin ─
for (const mod of ["usb", "node-hid"]) {
  const buildDir = abs("node_modules", mod, "build");
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    log(`removed stale Linux build: node_modules/${mod}/build`);
    changed++;
  }
}
(() => {
  const sharpPkg = JSON.parse(fs.readFileSync(abs("node_modules/sharp/package.json"), "utf8"));
  const opt = sharpPkg.optionalDependencies || {};
  const wanted = {
    "@img/sharp-darwin-arm64": opt["@img/sharp-darwin-arm64"] || sharpPkg.version,
    "@img/sharp-libvips-darwin-arm64": opt["@img/sharp-libvips-darwin-arm64"],
  };
  const imgDir = abs("node_modules/@img");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sharp-darwin-"));
  for (const [name, version] of Object.entries(wanted)) {
    const dest = path.join(imgDir, name.split("/")[1]);
    if (fs.existsSync(path.join(dest, "package.json"))) {
      log(`sharp/darwin "${name}" already present`);
      continue;
    }
    if (!version) throw new Error(`could not resolve version for ${name} from sharp optionalDependencies`);
    log(`fetching ${name}@${version} ...`);
    execFileSync("npm", ["pack", `${name}@${version}`, "--silent"], { cwd: tmp, stdio: ["ignore", "ignore", "inherit"] });
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz") && f.includes(name.split("/")[1]));
    execFileSync("tar", ["xzf", tgz], { cwd: tmp });
    fs.mkdirSync(dest, { recursive: true });
    execFileSync("cp", ["-R", path.join(tmp, "package") + "/.", dest]);
    fs.rmSync(path.join(tmp, "package"), { recursive: true, force: true });
    fs.rmSync(path.join(tmp, tgz), { force: true });
    log(`installed ${name}`);
    changed++;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
})();

console.log(`\napply-macos-changes: ${changed} change(s) applied to ${appDir}`);
