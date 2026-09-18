// electron-builder afterSign hook — applies an adhoc signature with entitlements
// and a stable bundle identifier so macOS TCC has something to track.
//
// Without this, electron-builder leaves the app linker-signed-only with
// Identifier=Electron, no entitlements, no sealed resources — which prevents
// the system from binding the Input Monitoring grant to a stable identity.
//
// This is NOT a substitute for a real Developer ID + notarization. The user
// still must dequarantine (xattr -d com.apple.quarantine …) or right-click ->
// Open on first launch. But once trusted, the entitlements + hardened runtime
// + sealed resources give TCC a stable identity to bind grants to.

const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function macosAdhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = path.join(context.packager.info.projectDir, "build", "entitlements.mac.plist");
  const identifier = context.packager.appInfo.id; // com.azeron.software per package.json

  console.log(`[macos-adhoc-sign] re-signing ${appPath}`);
  console.log(`[macos-adhoc-sign] identifier=${identifier}`);
  console.log(`[macos-adhoc-sign] entitlements=${entitlements}`);

  execFileSync(
    "codesign",
    [
      "--force",
      "--deep",
      "--options", "runtime",
      "--identifier", identifier,
      "--entitlements", entitlements,
      "--sign", "-",
      appPath,
    ],
    { stdio: "inherit" }
  );

  console.log("[macos-adhoc-sign] verification:");
  execFileSync("codesign", ["-dv", "--verbose=2", appPath], { stdio: "inherit" });
};
