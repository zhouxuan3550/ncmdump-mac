// Bundle the host's TagLib dylib into the macOS .app and re-point the
// sidecar binary's loader path to it via @rpath. Handles both Apple Silicon
// (Homebrew at /opt/homebrew) and Intel (Homebrew at /usr/local). Supports
// ad-hoc signing for local development; release builds should override
// `SIGN_IDENTITY` to use a Developer ID and run `notarytool` afterwards.

import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const appPath = join(root, "src-tauri", "target", "release", "bundle", "macos", "NCM 转换器.app");
const resourcesPath = join(appPath, "Contents", "Resources");
const sidecarPath = join(appPath, "Contents", "MacOS", "ncmdump");

function run(cmd, args) {
	return execFileSync(cmd, args, { stdio: "inherit" });
}
function runOrNull(cmd, args) {
	try {
		return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
	} catch {
		return null;
	}
}
function ensure(cond, msg) {
	if (!cond) throw new Error(msg);
}

if (!existsSync(appPath)) {
	throw new Error(`App bundle not found at ${appPath}. Run \`npm run desktop:build\` first.`);
}
if (!existsSync(sidecarPath)) {
	throw new Error(`Sidecar binary not found inside bundle at ${sidecarPath}.`);
}

// Find a TagLib dylib that the sidecar was linked against. Prefer the path
// the binary currently references; fall back to a Homebrew lookup.
const linkedLibs = execFileSync("otool", ["-L", sidecarPath], { encoding: "utf8" });
// otool -L lines look like:  "\t<path> (compatibility version X, ...)"
// The path itself may contain spaces (e.g. "NCM 转换器.app/..."), so split on
// the version parenthesis rather than on whitespace.
const referencedTaglib = linkedLibs
	.split("\n")
	.map((l) => l.trim())
	.map((l) => l.split(" (")[0])
	.find((p) => p && p.includes("libtag.") && p.endsWith(".dylib"));
ensure(referencedTaglib, "Could not determine which libtag the sidecar is linked to (otool).");

mkdirSync(resourcesPath, { recursive: true });
const bundledTaglib = join(resourcesPath, "libtag.2.dylib");

// Idempotent: if the sidecar already references the bundled copy, just
// re-sign instead of touching install paths again.
const alreadyBundled = referencedTaglib === bundledTaglib;
if (alreadyBundled) {
	console.log("Sidecar already references bundled libtag; skipping re-link.");
} else {
	let sourceTaglib = realpathSync(referencedTaglib);
	if (!existsSync(sourceTaglib)) {
		const brewPrefix = runOrNull("brew", ["--prefix", "taglib"]);
		if (brewPrefix) {
			const candidate = join(brewPrefix.trim(), "lib", "libtag.2.dylib");
			if (existsSync(candidate)) sourceTaglib = realpathSync(candidate);
		}
	}
	ensure(existsSync(sourceTaglib), `TagLib dylib not found at ${sourceTaglib}`);

	copyFileSync(sourceTaglib, bundledTaglib);

	// Re-point the sidecar at the copy inside the bundle.
	run("install_name_tool", ["-change", referencedTaglib, bundledTaglib, sidecarPath]);

	// Re-base the dylib itself so its own internal references resolve.
	try {
		run("install_name_tool", [
			"-id",
			"@executable_path/../Resources/libtag.2.dylib",
			bundledTaglib,
		]);
	} catch (err) {
		console.warn("install_name_tool -id on the bundled dylib failed (usually safe to ignore).");
	}
}

// Sign. Default: ad-hoc for local dev. Release builds should set
// SIGN_IDENTITY="Developer ID Application: ..." and run notarytool.
//
// macOS 15 enforces ordered signing of nested code: sign the bundled dylib
// first, then the sidecar that links it, then the .app as a whole. Signing
// `--deep` first invalidates inner signatures and triggers AMFI to kill the
// binary at exec time.
const identity = process.env.SIGN_IDENTITY ?? "-";
console.log(`Codesigning with identity: ${identity}`);
run("codesign", ["--force", "--sign", identity, bundledTaglib]);
run("codesign", ["--force", "--sign", identity, sidecarPath]);
run("codesign", ["--force", "--deep", "--sign", identity, appPath]);

if (identity !== "-" && process.env.NOTARY_PROFILE) {
	console.log("Submitting for notarization…");
	run("xcrun", [
		"notarytool",
		"submit",
		appPath,
		"--keychain-profile",
		process.env.NOTARY_PROFILE,
		"--wait",
	]);
	run("xcrun", ["stapler", "staple", appPath]);
}

console.log(`✓ Bundled TagLib into ${appPath}`);
