import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";

import {
  bundleElectron,
  ELECTRON_ENTRYPOINTS,
  formatBuildLogs,
  runElectronBundleCli,
} from "./electron-bundle.js";
import { buildDesktop } from "./build.js";

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

  test("lists every hard-coded BrowserWindow preload as a bundle entrypoint", async () => {
    const electronRoot = path.join(packageRoot, "electron");
    const sources = (await readdir(electronRoot, { recursive: true })).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    const loaded = new Set<string>();
    for (const source of sources) {
      const text = await readFile(path.join(electronRoot, source), "utf8");
      for (const match of text.matchAll(
        /preload:\s*path\.join\(\s*options\.dirname,\s*["']([^"']+\.js)["']/g,
      )) {
        loaded.add(`electron/${match[1]!.replace(/\.js$/, ".ts")}`);
      }
    }
    expect(loaded.size).toBeGreaterThan(0);
    expect([...loaded].sort()).toEqual(
      ELECTRON_ENTRYPOINTS.filter((entrypoint) => entrypoint !== "electron/main.ts").sort(),
    );
  });

  test("reports a failed bundle with source position through the CLI path", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-bundle-failure-"));
    try {
      const electron = path.join(fixture, "electron");
      await mkdir(electron);
      await writeFile(path.join(electron, "main.ts"), 'import "./missing.js";\n');
      await writeFile(path.join(electron, "preload.ts"), "export {};\n");
      await writeFile(path.join(electron, "toolchain-bootstrap-preload.ts"), "export {};\n");
      const errors: string[] = [];
      expect(
        await runElectronBundleCli(fixture, path.join(fixture, "dist"), (message) =>
          errors.push(message),
        ),
      ).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/error: .*main\.ts:1:\d+: .*missing/);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("production build reports a failed bundle and exits unsuccessfully", async () => {
    const errors: string[] = [];
    let removedOutput = false;
    const status = await buildDesktop({
      typecheck: () => 0,
      removeOutput: () => {
        removedOutput = true;
      },
      bundle: async () =>
        ({
          success: false,
          outputs: [],
          logs: [{ level: "error", message: "bundle failure", position: null }],
        }) as unknown as Bun.BuildOutput,
      reportError: (message) => errors.push(message),
    });
    expect(removedOutput).toBe(true);
    expect(status).toBe(1);
    expect(errors).toEqual(["error: bundle failure"]);
  });

  test("formats positioned warnings", () => {
    const output = {
      logs: [
        {
          level: "warning",
          message: "check this import",
          position: { file: "/src/main.ts", line: 4, column: 7 },
        },
      ],
    } as unknown as Bun.BuildOutput;
    expect(formatBuildLogs(output)).toBe("warning: /src/main.ts:4:7: check this import");
  });
});
