// Prepare the C++ ncmdump binary for use as a Tauri sidecar.
//
// Behavior:
//  - Always builds the host architecture first.
//  - On macOS, if both arm64 and x86_64 SDKs are available, also builds the
//    other slice and stitches them into a universal binary via `lipo`.
//  - Copies the produced binary (per target triple) into src-tauri/binaries/
//    using the name Tauri's externalBin lookup expects: `ncmdump-<triple>`.

import { copyFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const buildDir = join(root, "build");
const sidecarDir = join(root, "src-tauri", "binaries");

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function runOrNull(cmd, args) {
	try {
		return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
	} catch {
		return null;
	}
}

function ensure(cond, message) {
	if (!cond) throw new Error(message);
}

// Build a single-arch binary into build/<arch>/ncmdump.
function buildArch(arch) {
	const archDir = join(buildDir, arch);
	mkdirSync(archDir, { recursive: true });
	const archFlag =
		arch === "arm64" ? "-DCMAKE_OSX_ARCHITECTURES=arm64" : "-DCMAKE_OSX_ARCHITECTURES=x86_64";
	run("cmake", ["-DCMAKE_BUILD_TYPE=Release", archFlag, "-S", root, "-B", archDir]);
	run("cmake", ["--build", archDir, "-j"]);
	const binary = join(archDir, "ncmdump");
	ensure(existsSync(binary), `build for ${arch} did not produce ${binary}`);
	return binary;
}

// Probe whether the installed taglib can satisfy a given architecture. On
// arm64-only Homebrew installs, this lets us gracefully skip x86_64 instead
// of failing the link step.
function taglibSupportsArch(arch) {
	if (process.platform !== "darwin") return true;
	const taglibPath = runOrNull("brew", ["--prefix", "taglib"]);
	if (!taglibPath) return true; // can't tell — let the link step decide.
	const lib = join(taglibPath.trim(), "lib", "libtag.2.dylib");
	if (!existsSync(lib)) return true;
	const info = runOrNull("lipo", ["-info", lib]);
	if (!info) return true;
	if (arch === "arm64") return info.includes("arm64");
	if (arch === "x86_64") return info.includes("x86_64");
	return false;
}

function maybeBuildArch(arch) {
	if (!taglibSupportsArch(arch)) {
		console.warn(`! TagLib lacks ${arch} slice; skipping ${arch} build`);
		return null;
	}
	return buildArch(arch);
}

function detectHost() {
	const out = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
	const host = out
		.split("\n")
		.find((line) => line.startsWith("host:"))
		?.replace("host:", "")
		.trim();
	ensure(host, "Unable to detect Rust host triple");
	return host;
}

function tripleForArch(arch) {
	const host = process.env.TAURI_ENV_TARGET_TRIPLE;
	if (host) return host;
	if (arch === "arm64") return "aarch64-apple-darwin";
	if (arch === "x86_64") return "x86_64-apple-darwin";
	return host;
}

function installSidecar(binary, arch) {
	const triple = tripleForArch(arch);
	const sidecar = join(sidecarDir, `ncmdump-${triple}`);
	mkdirSync(sidecarDir, { recursive: true });
	copyFileSync(binary, sidecar);
	chmodSync(sidecar, 0o755);
	console.log(`✓ Prepared sidecar: ${sidecar}`);
	return sidecar;
}

function tryMakeUniversal(arm64Binary, x64Binary) {
	if (process.platform !== "darwin") return null;
	const lipoCheck = runOrNull("lipo", ["-info", arm64Binary]);
	if (!lipoCheck) {
		console.warn("! lipo not available; skipping universal binary");
		return null;
	}
	const out = join(buildDir, "ncmdump-universal");
	run("lipo", ["-create", arm64Binary, x64Binary, "-output", out]);
	const triple = tripleForArch(process.arch === "arm64" ? "arm64" : "x86_64");
	return installSidecar(out, process.arch === "arm64" ? "arm64" : "x86_64");
}

function main() {
	ensure(existsSync(join(root, "CMakeLists.txt")), "Run this from the project root");

	const hostTriple = process.env.TAURI_ENV_TARGET_TRIPLE || detectHost();
	console.log(`Rust host triple: ${hostTriple}`);

	mkdirSync(buildDir, { recursive: true });

	const isMac = process.platform === "darwin";

	if (isMac && process.env.UNIVERSAL !== "0") {
		const arm64 = maybeBuildArch("arm64");
		const x64 = maybeBuildArch("x86_64");
		if (arm64) installSidecar(arm64, "arm64");
		if (x64) installSidecar(x64, "x86_64");
		if (arm64 && x64) tryMakeUniversal(arm64, x64);
		else console.warn("! Only one slice built; skipping universal binary");
	} else {
		const binary = join(buildDir, "ncmdump");
		run("cmake", ["-DCMAKE_BUILD_TYPE=Release", "-S", root, "-B", buildDir]);
		run("cmake", ["--build", buildDir, "-j"]);
		installSidecar(
			binary,
			process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : hostTriple
		);
	}
}

main();
