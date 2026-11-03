import type { Configuration } from "electron-builder";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  build: Configuration;
};

/**
 * Where `mise run package:linux:unpacked:test` writes its build. Kept apart
 * from `release/`, so `package:linux`'s installer and every release step only
 * ever find the hardened build.
 */
export const PACKAGED_TEST_OUTPUT_DIRECTORY = "release/packaged-test";

/**
 * The unpacked build the packaged Electron spec launches
 * (`e2e/agent-testing/design-canvas-packaged-electron.spec.ts`). It is the
 * package.json build with one fuse turned back on: Node's `--inspect`
 * arguments. Playwright's `_electron.launch` passes `--inspect=0` and drives
 * the main process through that inspector, so it cannot start an app whose
 * fuse is off. Every other fuse stays as shipped, `NODE_OPTIONS` included.
 *
 * This build is for that spec only: it is never installed, signed or
 * published, and nothing else reads its output directory.
 */
export function createPackagedTestConfig(): Configuration {
  return {
    ...packageJson.build,
    directories: {
      ...packageJson.build.directories,
      output: PACKAGED_TEST_OUTPUT_DIRECTORY,
    },
    electronFuses: {
      ...packageJson.build.electronFuses,
      enableNodeCliInspectArguments: true,
    },
  };
}

export default function packagedTestConfig(): Configuration {
  return createPackagedTestConfig();
}
