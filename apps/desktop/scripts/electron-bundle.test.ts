import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";

import { bundleElectron, ELECTRON_ENTRYPOINTS, formatBuildLogs } from "./electron-bundle.js";

const packageRoot = path.resolve(import.meta.dir, "..");
const builtins = new Set(builtinModules);

// Electron's Node loads the bundle as-is. Anything the bundle still imports
// must resolve without TypeScript compilation: workspace packages export raw
// `.ts` sources that strip-only type stripping cannot run.
function isRuntimeResolvable(specifier: string): boolean {
  if (specifier === "electron" || specifier.startsWith("electron/")) return true;
  if (specifier.startsWith("node:")) return true;
  return builtins.has(specifier);
}

describe("Electron bundle", () => {
  let outdir: string | undefined;
  afterAll(async () => {
    if (outdir) await rm(outdir, { recursive: true, force: true });
  });

  test("inlines every workspace import so the main process never loads raw TypeScript", async () => {
    outdir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-bundle-"));
    const result = await bundleElectron(packageRoot, outdir);
    expect(formatBuildLogs(result)).not.toContain("error:");
    expect(result.success).toBe(true);

    const entryOutputs = ELECTRON_ENTRYPOINTS.map((entrypoint) =>
      path.join(outdir!, `${path.basename(entrypoint, ".ts")}.js`),
    );
    const outputs = result.outputs
      .filter((artifact) => artifact.kind !== "sourcemap")
      .map((artifact) => artifact.path);
    for (const entry of entryOutputs) expect(outputs).toContain(entry);

    const transpiler = new Bun.Transpiler({ loader: "js" });
    const unresolvable: string[] = [];
    for (const output of outputs) {
      const source = await readFile(output, "utf8");
      for (const { path: specifier } of transpiler.scanImports(source)) {
        if (!isRuntimeResolvable(specifier)) {
          unresolvable.push(`${path.basename(output)} -> ${specifier}`);
        }
      }
    }
    expect(unresolvable).toEqual([]);
  }, 60_000);
});
