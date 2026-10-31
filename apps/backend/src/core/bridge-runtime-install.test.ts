import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BRIDGE_RUNTIMES_DIRECTORY,
  ensureBridgeRuntime,
  isBridgeRuntimeInstalled,
  onDemandBridgeRuntime,
} from "./bridge-runtime-install.js";
import { CommandFailedError, type runCommand } from "./shell.js";

let root: string;
let resourceRoot: string;
let dataDir: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-bridge-runtime-")));
  resourceRoot = path.join(root, "resources");
  dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * An on-demand bridge laid out the way `packages/cli/scripts/build.ts` stages
 * one. Its single dependency is a local `file:` package, so a real
 * `bun install --frozen-lockfile` runs without the network.
 */
async function stageBridge(
  bridge: string,
  digest: string,
  options: { lockfile?: boolean } = {},
): Promise<void> {
  const sourceDir = path.join(resourceRoot, bridge);
  const runtime = path.join(sourceDir, "runtime");
  await fs.mkdir(path.join(sourceDir, "dist"), { recursive: true });
  await fs.mkdir(path.join(runtime, "vendor", "greeting"), { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, "dist", "index.js"),
    'import { greeting } from "greeting";\nconsole.log(greeting);\n',
  );
  await fs.writeFile(
    path.join(runtime, "vendor", "greeting", "package.json"),
    JSON.stringify({ name: "greeting", version: "1.0.0", type: "module", main: "index.js" }),
  );
  await fs.writeFile(
    path.join(runtime, "vendor", "greeting", "index.js"),
    'export const greeting = "installed";\n',
  );
  await fs.writeFile(
    path.join(runtime, "package.json"),
    JSON.stringify({
      name: `${bridge}-runtime`,
      private: true,
      type: "module",
      dependencies: { greeting: "file:./vendor/greeting" },
    }),
  );
  if (options.lockfile !== false) {
    const lock = Bun.spawn([process.execPath, "install", "--lockfile-only"], {
      cwd: runtime,
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await lock.exited) !== 0) throw new Error(await new Response(lock.stderr).text());
  }
  await fs.writeFile(path.join(runtime, "install.json"), JSON.stringify({ bridge, digest }));
}

function runtimeFor(bridge: string) {
  const runtime = onDemandBridgeRuntime(resourceRoot, () => dataDir, bridge);
  if (!runtime) throw new Error(`${bridge} is not an on-demand bridge`);
  return runtime;
}

test("a resource directory without an install descriptor is a complete bridge", async () => {
  await fs.mkdir(path.join(resourceRoot, "cursor-bridge", "dist"), { recursive: true });
  expect(onDemandBridgeRuntime(resourceRoot, () => dataDir, "cursor-bridge")).toBeUndefined();
});

test("installs into the data directory under the digest and runs from there", async () => {
  await stageBridge("cursor-bridge", "0123456789abcdef");
  const runtime = runtimeFor("cursor-bridge");
  expect(runtime.installDir).toBe(
    path.join(dataDir, BRIDGE_RUNTIMES_DIRECTORY, "cursor-bridge", "0123456789abcdef"),
  );
  expect(isBridgeRuntimeInstalled(runtime)).toBe(false);

  const installDir = await ensureBridgeRuntime(runtime, { bun: process.execPath });

  expect(installDir).toBe(runtime.installDir);
  expect(isBridgeRuntimeInstalled(runtime)).toBe(true);
  // The bundle resolves its external from the installed tree.
  const child = Bun.spawn([process.execPath, path.join(installDir, "dist", "index.js")], {
    cwd: installDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect((await new Response(child.stdout).text()).trim()).toBe("installed");
  expect(await child.exited).toBe(0);
  // Nothing is left half-built beside it.
  expect(await fs.readdir(path.dirname(installDir))).toEqual(["0123456789abcdef"]);
});

test("concurrent starts share one install and later ones reuse it", async () => {
  await stageBridge("pi-bridge", "fedcba9876543210");
  const runtime = runtimeFor("pi-bridge");
  let installs = 0;
  const run = (async (_command: string, _args?: string[], options?: { cwd?: string }) => {
    installs += 1;
    await fs.mkdir(path.join(options!.cwd!, "node_modules"), { recursive: true });
    return { stdout: "", stderr: "" };
  }) as typeof runCommand;

  const [first, second] = await Promise.all([
    ensureBridgeRuntime(runtime, { bun: "bun", run }),
    ensureBridgeRuntime(runtime, { bun: "bun", run }),
  ]);
  await ensureBridgeRuntime(runtime, { bun: "bun", run });

  expect(first).toBe(runtime.installDir);
  expect(second).toBe(runtime.installDir);
  expect(installs).toBe(1);
});

test("an upgrade removes superseded runtimes and dead staging directories", async () => {
  const bridgeRoot = path.join(dataDir, BRIDGE_RUNTIMES_DIRECTORY, "cursor-bridge");
  await fs.mkdir(path.join(bridgeRoot, "1111111111111111"), { recursive: true });
  await fs.mkdir(path.join(bridgeRoot, ".staging-2222222222222222-1-1"), { recursive: true });
  await stageBridge("cursor-bridge", "3333333333333333");
  const run = (async () => ({ stdout: "", stderr: "" })) as typeof runCommand;

  await ensureBridgeRuntime(runtimeFor("cursor-bridge"), { bun: "bun", run });

  expect(await fs.readdir(bridgeRoot)).toEqual(["3333333333333333"]);
});

test("a failed install says which platform failed and leaves nothing installed", async () => {
  await stageBridge("cursor-bridge", "4444444444444444");
  const runtime = runtimeFor("cursor-bridge");
  const run = (async () => {
    throw new CommandFailedError("error: GET https://registry.npmjs.org/@cursor%2fsdk - 503");
  }) as typeof runCommand;

  await expect(ensureBridgeRuntime(runtime, { bun: "bun", run })).rejects.toThrow(
    "Could not install Cursor support: error: GET https://registry.npmjs.org/@cursor%2fsdk - 503",
  );
  expect(isBridgeRuntimeInstalled(runtime)).toBe(false);
  expect(await fs.readdir(path.dirname(runtime.installDir))).toEqual([]);

  const timedOut = (async () => {
    throw new CommandFailedError("", { timedOut: true });
  }) as typeof runCommand;
  await expect(ensureBridgeRuntime(runtime, { bun: "bun", run: timedOut })).rejects.toThrow(
    "Could not install Cursor support: bun install timed out",
  );
});

test("refuses to install without the lockfile that pins the closure", async () => {
  // Bun ignores --frozen-lockfile when there is no lockfile at all, and would
  // resolve the newest versions the manifest's ranges allow.
  await stageBridge("pi-bridge", "5555555555555555", { lockfile: false });
  let installs = 0;
  const run = (async () => {
    installs += 1;
    return { stdout: "", stderr: "" };
  }) as typeof runCommand;

  await expect(ensureBridgeRuntime(runtimeFor("pi-bridge"), { bun: "bun", run })).rejects.toThrow(
    "Could not install Pi support: the package is missing its lockfile",
  );
  expect(installs).toBe(0);
});

test("rejects a descriptor whose digest is not a plain hex name", async () => {
  await stageBridge("cursor-bridge", "../../escape");
  expect(() => onDemandBridgeRuntime(resourceRoot, () => dataDir, "cursor-bridge")).toThrow(
    "invalid digest",
  );
});
