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

function run(command: string, args: string[]): number {
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: "inherit", env: process.env });
  return result.status ?? 1;
}

export async function buildDesktop(
  dependencies: {
    typecheck?: () => number;
    removeOutput?: () => void;
    bundle?: typeof bundleElectron;
    reportError?: (message: string) => void;
    reportArtifact?: (message: string) => void;
  } = {},
): Promise<number> {
  const status = (
    dependencies.typecheck ??
    (() => run("bunx", ["tsc", "--noEmit", "-p", "tsconfig.electron.json"]))
  )();
  if (status !== 0) return status;
  (dependencies.removeOutput ?? (() => rmSync(output, { recursive: true, force: true })))();

  const result = await (dependencies.bundle ?? bundleElectron)(
    packageRoot,
    path.join(output, "electron"),
  );
  if (!result.success) {
    (dependencies.reportError ?? console.error)(formatBuildLogs(result));
    return 1;
  }

  for (const artifact of result.outputs) {
    (dependencies.reportArtifact ?? console.log)(
      `${path.relative(packageRoot, artifact.path)} ${artifact.size} bytes`,
    );
  }
  return 0;
}

if (import.meta.main) process.exitCode = await buildDesktop();
