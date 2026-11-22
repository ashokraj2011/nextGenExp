import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = JSON.parse(readFileSync(join(root, "build-baseline.json"), "utf8"));
const runtimeDir = join(root, ".runtime", "sfield");
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

if (execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim() !== baseline.pnpm) {
  throw new Error("Install pnpm " + baseline.pnpm + " before running setup.");
}
if (!existsSync(join(runtimeDir, ".git"))) {
  mkdirSync(runtimeDir, { recursive: true });
  run("git", ["init", "--quiet"], runtimeDir);
}
const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
  cwd: runtimeDir, encoding: "utf8",
});
const hasPinnedSource = head.status === 0 && head.stdout.trim() === baseline.sfieldCommit;
if (!hasPinnedSource) {
  run("git", ["fetch", "--quiet", "--depth", "1", baseline.sfieldRepository, baseline.sfieldCommit], runtimeDir);
  run("git", ["checkout", "--quiet", "--detach", baseline.sfieldCommit], runtimeDir);
}
const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: runtimeDir, encoding: "utf8" }).trim();
if (actual !== baseline.sfieldCommit) throw new Error("sfield source pin did not resolve");
if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: runtimeDir }).length) {
  throw new Error("The pinned sfield source has local changes.");
}
run("pnpm", ["install", "--frozen-lockfile"], runtimeDir);
run("pnpm", ["run", "build"], runtimeDir);
run("pnpm", ["install", "--frozen-lockfile"]);
