/**
 * Where the toolchain lives inside a data directory.
 *
 * Kept free of installer imports so the backend can resolve its default
 * `--toolchain-bin-dir` from the same definition the installer writes to,
 * without pulling the downloader and its archive readers into its bundle.
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

export const TOOLCHAIN_DIRECTORY = "toolchains";

/**
 * A stable name for "the set that was installed last".
 *
 * The manager gives every activated set its own directory, named by a digest of
 * what is in it, so a running build keeps the exact layout it started with. A
 * process that is started later needs *a* path it can be configured with once,
 * and this is it: `<dataDir>/toolchains/bin/current`.
 */
export const CURRENT_TOOLCHAIN_LINK = "current";

/** The toolchain root this package owns inside a given data directory. */
export function toolchainRootDir(dataDir: string): string {
  return path.join(dataDir, TOOLCHAIN_DIRECTORY);
}

/** The directory `--toolchain-bin-dir` should point at after a successful install. */
export function currentToolchainBinDir(dataDir: string): string {
  return path.join(toolchainRootDir(dataDir), "bin", CURRENT_TOOLCHAIN_LINK);
}

/**
 * Where a backend looks for the pinned agent binaries when nothing says.
 *
 * `orkestrator toolchain install` leaves `toolchains/bin/current` pointing at the
 * set it verified, so that is preferred once it exists. Before that, and for a
 * directory someone filled by hand, the plain `toolchains/bin` is what was always
 * searched. The choice is made at startup: a backend that was already running
 * when a new set was installed keeps the executables it resolved until restarted.
 *
 * The desktop app provisions the same data directory but hands its backend the
 * set directory directly and never writes `current`. A headless backend started
 * on that directory would find nothing in `toolchains/bin` itself, so when the
 * only thing there is a single non-empty set, that set is the answer. Several
 * sets are ambiguous and are left to `toolchain install` to resolve.
 */
export function defaultToolchainBinDir(dataDir: string): string {
  const current = currentToolchainBinDir(dataDir);
  if (existsSync(current)) return realpathSync(current);
  const binRoot = path.join(toolchainRootDir(dataDir), "bin");
  return soleActivatedToolchainSet(binRoot) ?? binRoot;
}

function soleActivatedToolchainSet(binRoot: string): string | undefined {
  try {
    const entries = readdirSync(binRoot, { withFileTypes: true }).filter(
      (entry) => !entry.name.startsWith("."),
    );
    const [only] = entries;
    if (entries.length !== 1 || !only?.isDirectory()) return undefined;
    const set = path.join(binRoot, only.name);
    return readdirSync(set).length > 0 ? realpathSync(set) : undefined;
  } catch {
    return undefined;
  }
}
