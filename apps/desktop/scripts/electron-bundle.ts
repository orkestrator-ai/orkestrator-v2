import path from "node:path";
import process from "node:process";

/** Every preload a BrowserWindow or WebContentsView loads must be listed here. */
export const ELECTRON_PRELOAD_ENTRYPOINTS = [
  "electron/preload.ts",
  "electron/toolchain-bootstrap-preload.ts",
] as const;

/** Electron main-process and preload entrypoints, relative to the desktop package root. */
export const ELECTRON_ENTRYPOINTS = ["electron/main.ts", ...ELECTRON_PRELOAD_ENTRYPOINTS] as const;

/**
 * Bundle the Electron main process and preloads into `outdir`.
 *
 * Production packaging and the development launcher both use this, so the two
 * cannot drift. Bundling is load-bearing: workspace packages such as
 * `@orkestrator/protocol` export raw `.ts` sources, and Electron's Node can
 * only strip types from those, not compile them (parameter properties, enums
 * and `.js`-suffixed relative imports all fail at runtime). `tsc` is used for
 * type checking only.
 */
export async function bundleElectron(
  packageRoot: string,
  outdir: string,
): Promise<Bun.BuildOutput> {
  const build = (entrypoints: readonly string[], format: "esm" | "cjs") =>
    Bun.build({
      entrypoints: entrypoints.map((entrypoint) => path.join(packageRoot, entrypoint)),
      outdir,
      target: "node",
      format,
      external: ["electron"],
      sourcemap: "external",
      // Report failures through `success` and `logs` so callers can write them
      // to their own log instead of handling an AggregateError.
      throw: false,
    });
  const [main, preloads] = await Promise.all([
    build(["electron/main.ts"], "esm"),
    // Sandboxed Chromium evaluates a preload as a CommonJS function body whose
    // `require` loads only "electron", so everything else is inlined here.
    build(ELECTRON_PRELOAD_ENTRYPOINTS, "cjs"),
  ]);
  return {
    ...main,
    success: main.success && preloads.success,
    outputs: [...main.outputs, ...preloads.outputs],
    logs: [...main.logs, ...preloads.logs],
  };
}

export function formatBuildLogs(result: Bun.BuildOutput): string {
  return result.logs
    .map((log) => {
      const where = log.position
        ? `${log.position.file}:${log.position.line}:${log.position.column}: `
        : "";
      return `${log.level}: ${where}${log.message}`;
    })
    .join("\n");
}

export async function runElectronBundleCli(
  packageRoot: string,
  outdir: string,
  reportError: (message: string) => void = console.error,
): Promise<boolean> {
  const result = await bundleElectron(packageRoot, outdir);
  if (!result.success) reportError(formatBuildLogs(result));
  return result.success;
}

// `bun scripts/electron-bundle.ts` bundles into dist/electron for callers that
// cannot run Bun.build themselves, such as the Node-hosted Playwright suites.
if (import.meta.main) {
  const packageRoot = path.resolve(import.meta.dir, "..");
  if (!(await runElectronBundleCli(packageRoot, path.join(packageRoot, "dist", "electron"))))
    process.exit(1);
}
