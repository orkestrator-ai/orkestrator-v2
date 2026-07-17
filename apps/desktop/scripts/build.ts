import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

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

const result = await Bun.build({
  entrypoints: [
    path.join(packageRoot, "electron/main.ts"),
    path.join(packageRoot, "electron/preload.ts"),
    path.join(packageRoot, "electron/toolchain-bootstrap-preload.ts"),
  ],
  outdir: path.join(output, "electron"),
  target: "node",
  format: "esm",
  external: ["electron"],
  sourcemap: "external",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const artifact of result.outputs) {
  console.log(`${path.relative(packageRoot, artifact.path)} ${artifact.size} bytes`);
}
