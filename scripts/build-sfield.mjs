import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const { sfieldCommit, sfieldRepository } = readJson(join(root, "build-baseline.json"));
const checkout = join(root, ".runtime", "sfield");
const workspace = join(root, "vendor", "sfield");
const packages = ["core", "testing", "store-sqlite"];
const stamp = join(workspace, ".source-commit");
const require = createRequire(import.meta.url);
const compiler = require.resolve("typescript/bin/tsc");

const sourceReady = existsSync(stamp) && readFileSync(stamp, "utf8").trim() === sfieldCommit &&
  existsSync(join(workspace, "tsconfig.base.json")) &&
  packages.every((name) => existsSync(join(workspace, "packages", name, "src", "index.ts")) &&
    existsSync(join(workspace, "packages", name, "tsconfig.json")));

if (!sourceReady) {
  const git = (args) => execFileSync("git", args, { cwd: checkout, stdio: "inherit" });
  if (!existsSync(join(checkout, ".git"))) {
    mkdirSync(checkout, { recursive: true });
    git(["init", "--quiet"]);
  }
  const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: checkout, encoding: "utf8",
  });
  const localChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: checkout });
  if (localChanges.length) throw new Error("The local sfield checkout has tracked changes.");

  if (head.status !== 0 || head.stdout.trim() !== sfieldCommit) {
    git(["fetch", "--quiet", "--depth", "1", "--", process.env.PZN_SFIELD_GIT_URL || sfieldRepository, sfieldCommit]);
    git(["checkout", "--quiet", "--detach", sfieldCommit]);
  }
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  if (actual !== sfieldCommit) throw new Error("sfield source pin did not resolve.");

  cpSync(join(checkout, "tsconfig.base.json"), join(workspace, "tsconfig.base.json"));
  for (const name of packages) {
    const source = join(checkout, "packages", name);
    const target = join(workspace, "packages", name);
    const upstream = readJson(join(source, "package.json"));
    const local = readJson(join(target, "package.json"));
    if (upstream.name !== local.name || upstream.version !== local.version) {
      throw new Error("Update the npm workspace manifest for " + upstream.name + " to match the pinned source.");
    }
    rmSync(join(target, "src"), { recursive: true, force: true });
    rmSync(join(target, "dist"), { recursive: true, force: true });
    rmSync(join(target, "tsconfig.tsbuildinfo"), { force: true });
    cpSync(join(source, "src"), join(target, "src"), { recursive: true });
    cpSync(join(source, "tsconfig.json"), join(target, "tsconfig.json"));
  }
  writeFileSync(stamp, sfieldCommit + "\n");
}

execFileSync(process.execPath, [compiler, "-b", join(workspace, "packages", "store-sqlite")], {
  cwd: root, stdio: "inherit",
});
