import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dir, "..");

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("turbo", [
  "--cwd", ".",
  "run", "test:workspace",
  "--filter=@orkestrator/web",
  "--filter=@orkestrator/backend",
  "--filter=@orkestrator/web-public",
  "--cache-dir", ".turbo",
]);
run("bun", ["test", "tests"]);
// The bridge packages have no `test` script of their own, so they are not part
// of the turbo run above. Without this their suites never execute in CI.
run("bun", ["test", "bridges"]);

const xcodeDeveloperDirectory = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
if (process.platform === "darwin" && existsSync(xcodeDeveloperDirectory)) {
  run("bun", ["scripts/test-ios.ts"]);
}
