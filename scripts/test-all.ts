import { spawnSync } from "node:child_process";
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
