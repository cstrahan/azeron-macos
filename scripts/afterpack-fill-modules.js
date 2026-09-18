// electron-builder afterPack hook.
//
// Our app/node_modules was assembled from the shipped app.asar (extraction +
// native-prebuild overlay), NOT a clean `npm install`. electron-builder's
// production-dependency walker treats that tree as partially "extraneous" and
// prunes real transitive deps (archiver-utils, color-name, color-string,
// winston-transport, yargs-parser, …), which crashes the packaged app at
// runtime ("Cannot find module 'archiver-utils'").
//
// Fix: after packing, mirror the full source node_modules into the bundle so it
// is byte-for-byte complete. Runs before the afterSign adhoc-codesign hook, so
// the signature seals the complete tree.

const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPackFillModules(context) {
  if (context.electronPlatformName !== "darwin") return;
  const src = path.join(context.packager.info.projectDir, "work", "app", "node_modules") + path.sep;
  const dst =
    path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
      "app",
      "node_modules"
    ) + path.sep;

  console.log(`[afterpack-fill-modules] mirroring full node_modules`);
  console.log(`[afterpack-fill-modules]   from ${src}`);
  console.log(`[afterpack-fill-modules]   to   ${dst}`);
  execFileSync("rsync", ["-a", "--delete", src, dst], { stdio: "inherit" });
};
