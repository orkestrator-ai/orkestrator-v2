import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { bundleElectron, formatBuildLogs } from "./electron-bundle.js";

if (process.platform === "win32") {
  throw new Error("Orkestrator desktop builds support macOS and Linux only.");
}

const packageRoot = path.resolve(import.meta.dir, "..");
const output = path.join(packageRoot, "dist");

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("bunx", ["tsc", "--noEmit", "-p", "tsconfig.electron.json"]);
rmSync(output, { recursive: true, force: true });

const result = await bundleElectron(packageRoot, path.join(output, "electron"));
if (!result.success) {
  console.error(formatBuildLogs(result));
  process.exit(1);
}

for (const artifact of result.outputs) {
  console.log(`${path.relative(packageRoot, artifact.path)} ${artifact.size} bytes`);
}
