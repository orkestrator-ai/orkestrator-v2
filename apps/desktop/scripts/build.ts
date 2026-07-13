import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

if (process.platform === "win32") {
  throw new Error("Orkestrator desktop builds support macOS and Linux only.");
}

const root = path.resolve(import.meta.dir, "..");

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(path.join(root, "dist"), { recursive: true, force: true });
run("bunx", ["tsc", "-p", "tsconfig.electron.json"]);
