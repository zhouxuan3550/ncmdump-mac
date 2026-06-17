import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const repo = process.env.GITHUB_REPOSITORY || "zhouxuan3550/ncmdump-mac";
const arch = process.env.BUNDLE_ARCH || (process.arch === "arm64" ? "aarch64" : process.arch);
const dmgDir = join(root, "src-tauri", "target", "release", "bundle", "dmg");
const sourceDmg = join(dmgDir, `NCM 转换器_${version}_${arch}.dmg`);
const releaseDmg = join(dmgDir, `NCM-Converter-${version}-${arch}.dmg`);

function run(cmd, args, options = {}) {
	return execFileSync(cmd, args, {
		cwd: root,
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		encoding: options.capture ? "utf8" : undefined,
	});
}

function ensure(condition, message) {
	if (!condition) throw new Error(message);
}

if (!process.env.ALLOW_DIRTY_RELEASE) {
	const status = run("git", ["status", "--porcelain"], { capture: true }).trim();
	ensure(!status, "工作区有未提交修改。提交后再发布，或设置 ALLOW_DIRTY_RELEASE=1。");
}

run("gh", ["auth", "status"]);
run("npm", ["run", arch === "x86_64" ? "desktop:build:x86_64" : "desktop:build"]);
ensure(existsSync(sourceDmg), `DMG 不存在：${sourceDmg}`);
run("hdiutil", ["verify", sourceDmg]);

mkdirSync(dmgDir, { recursive: true });
copyFileSync(sourceDmg, releaseDmg);

const notes = [
	"## 更新内容",
	"",
	"- NCM 转换器 macOS 版本",
	"- 支持批量转换、输出目录、同名策略、整理目录和菜单栏入口",
	"",
	"## 安装",
	"",
	"下载 DMG 后拖动应用到 Applications。",
].join("\n");

const releaseExists = (() => {
	try {
		run("gh", ["release", "view", tag, "--repo", repo], { capture: true });
		return true;
	} catch {
		return false;
	}
})();

if (releaseExists) {
	run("gh", ["release", "upload", tag, releaseDmg, "--repo", repo, "--clobber"]);
} else {
	run("gh", [
		"release",
		"create",
		tag,
		releaseDmg,
		"--repo",
		repo,
		"--title",
		`NCM 转换器 ${version}`,
		"--notes",
		notes,
	]);
}

console.log(`✓ GitHub Release ready: https://github.com/${repo}/releases/tag/${tag}`);
