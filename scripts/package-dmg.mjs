// Create a DMG installer for the macOS app, including an /Applications
// symlink so users can drag the app to install in one step. The output name
// is parameterised by version and architecture so multiple builds don't
// collide.

import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const appPath = join(root, "src-tauri", "target", "release", "bundle", "macos", "NCM 转换器.app");

const version =
	process.env.BUNDLE_VERSION ?? "0.1.0";
const arch =
	process.env.BUNDLE_ARCH ?? (process.arch === "arm64" ? "aarch64" : process.arch);
const volName = process.env.DMG_VOL_NAME ?? "NCM 转换器";

const stagingDir = join(root, "src-tauri", "target", "release", "bundle", "dmg-staging");
const dmgDir = join(root, "src-tauri", "target", "release", "bundle", "dmg");
const dmgName = `${volName}_${version}_${arch}.dmg`;
const dmgPath = join(dmgDir, dmgName);

function run(cmd, args) {
	return execFileSync(cmd, args, { stdio: "inherit" });
}
function ensure(cond, msg) {
	if (!cond) throw new Error(msg);
}

// Fresh staging area so we can add the Applications symlink and nothing else.
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
run("cp", ["-R", appPath, stagingDir]);
symlinkSync("/Applications", join(stagingDir, "Applications"));

mkdirSync(dmgDir, { recursive: true });
rmSync(dmgPath, { force: true });

run("hdiutil", [
	"create",
	"-volname",
	volName,
	"-srcfolder",
	stagingDir,
	"-ov",
	"-format",
	"UDZO",
	dmgPath,
]);

console.log(`✓ Created DMG: ${dmgPath}`);