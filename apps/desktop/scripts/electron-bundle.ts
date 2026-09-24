import path from "node:path";
import process from "node:process";

/**
 * Electron main-process entrypoints, relative to the desktop package root.
 * Every preload a BrowserWindow loads must be listed here.
 */
export const ELECTRON_ENTRYPOINTS = [
  "electron/main.ts",
  "electron/preload.ts",
  "electron/toolchain-bootstrap-preload.ts",
] as const;

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
  return Bun.build({
    entrypoints: ELECTRON_ENTRYPOINTS.map((entrypoint) => path.join(packageRoot, entrypoint)),
    outdir,
    target: "node",
    // ESM preloads require sandbox: false on BrowserWindow. A sandboxed
    // Chromium context evaluates preloads as CommonJS and cannot load these.
    format: "esm",
    external: ["electron"],
    sourcemap: "external",
    // Report failures through `success` and `logs` so callers can write them
    // to their own log instead of handling an AggregateError.
    throw: false,
  });
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

// `bun scripts/electron-bundle.ts` bundles into dist/electron for callers that
// cannot run Bun.build themselves, such as the Node-hosted Playwright suites.
if (import.meta.main) {
  const packageRoot = path.resolve(import.meta.dir, "..");
  const result = await bundleElectron(packageRoot, path.join(packageRoot, "dist", "electron"));
  if (!result.success) {
    console.error(formatBuildLogs(result));
    process.exit(1);
  }
}
