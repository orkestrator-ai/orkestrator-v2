/**
 * Where the toolchain lives inside a data directory.
 *
 * Kept free of imports so the backend can resolve its default
 * `--toolchain-bin-dir` from the same definition the installer writes to,
 * without pulling the downloader and its archive readers into its bundle.
 */
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
