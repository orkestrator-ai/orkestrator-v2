/**
 * Where `orkestrator serve --supervised` keeps installed versions, and the
 * pointers it swaps atomically:
 *
 *   <dataDir>/runtime/versions/<version>/   package.json + node_modules/orkestrator
 *   <dataDir>/runtime/current  -> versions/<version>
 *   <dataDir>/runtime/previous -> versions/<version>   (last known good)
 *   <dataDir>/runtime/supervisor-state.json            (in-flight cutover)
 *   <dataDir>/runtime/supervisor.lock                  (one supervisor per data dir)
 */
import path from "node:path";

export type RuntimeLayout = {
  root: string;
  versions: string;
  current: string;
  previous: string;
  state: string;
  lock: string;
};

export function runtimeLayout(dataDir: string): RuntimeLayout {
  const root = path.join(dataDir, "runtime");
  return {
    root,
    versions: path.join(root, "versions"),
    current: path.join(root, "current"),
    previous: path.join(root, "previous"),
    state: path.join(root, "supervisor-state.json"),
    lock: path.join(root, "supervisor.lock"),
  };
}

/** The directory `bun add` installs a version into. */
export function installDirFor(layout: RuntimeLayout, version: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(version)) {
    throw new Error(`Refusing an unsafe version name: ${JSON.stringify(version)}`);
  }
  return path.join(layout.versions, version);
}

/** The package root (`bin/`, `dist/`, `resources/`) inside an install directory. */
export function packageRootIn(installDir: string): string {
  return path.join(installDir, "node_modules", "orkestrator");
}

export function launcherIn(packageRoot: string): string {
  return path.join(packageRoot, "bin", "orkestrator.js");
}
