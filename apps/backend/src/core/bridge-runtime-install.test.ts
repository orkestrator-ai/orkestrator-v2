import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
  expect((await fs.readdir(path.dirname(installDir))).sort()).toEqual([
    ".install-lock.sqlite",
    "0123456789abcdef",
  ]);
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

test("an upgrade retains prior digests and live or unknown staging, removing only dead staging", async () => {
  const bridgeRoot = path.join(dataDir, BRIDGE_RUNTIMES_DIRECTORY, "cursor-bridge");
  await fs.mkdir(path.join(bridgeRoot, "1111111111111111"), { recursive: true });
  await fs.mkdir(path.join(bridgeRoot, ".staging-2222222222222222-2147483647-1"), {
    recursive: true,
  });
  const liveStaging = `.staging-2222222222222222-${process.pid}-1`;
  await fs.mkdir(path.join(bridgeRoot, liveStaging));
  await fs.mkdir(path.join(bridgeRoot, ".staging-unknown"));
  await stageBridge("cursor-bridge", "3333333333333333");
  const run = (async () => ({ stdout: "", stderr: "" })) as typeof runCommand;

  await ensureBridgeRuntime(runtimeFor("cursor-bridge"), { bun: "bun", run });

  expect((await fs.readdir(bridgeRoot)).sort()).toEqual(
    [
      ".install-lock.sqlite",
      liveStaging,
      ".staging-unknown",
      "1111111111111111",
      "3333333333333333",
    ].sort(),
  );
});

test("waiting for a live installer is bounded and a timeout can be retried", async () => {
  await stageBridge("pi-bridge", "ffffffffffffffff");
  const runtime = runtimeFor("pi-bridge");
  await fs.mkdir(path.dirname(runtime.installDir), { recursive: true });
  const lock = new Database(path.join(path.dirname(runtime.installDir), ".install-lock.sqlite"));
  lock.exec("BEGIN IMMEDIATE");
  try {
    await expect(
      ensureBridgeRuntime(runtime, { bun: process.execPath, timeoutMs: 10 }),
    ).rejects.toThrow("Timed out waiting");
  } finally {
    lock.close();
  }
  expect(await ensureBridgeRuntime(runtime, { bun: process.execPath })).toBe(runtime.installDir);
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
  expect(await fs.readdir(path.dirname(runtime.installDir))).toEqual([".install-lock.sqlite"]);

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

// The worker imports the real installer into a separate module/flight map.
async function installerWorker(digest: string, pause: boolean) {
  const worker = path.join(root, "installer.ts");
  await fs.writeFile(
    worker,
    `
    import { ensureBridgeRuntime } from ${JSON.stringify(path.join(import.meta.dir, "bridge-runtime-install.ts"))};
    import { runCommand } from ${JSON.stringify(path.join(import.meta.dir, "shell.ts"))};
    const runtime = JSON.parse(process.argv[2]);
    const marker = process.argv[3];
    await Bun.write(marker + ".started", "started");
    await ensureBridgeRuntime(runtime, { bun: process.execPath, run: async (...args) => {
      await Bun.write(marker + ".staging", args[2].cwd);
      if (process.argv[4] === "pause") await Bun.stdin.text();
      return runCommand(...args);
    }});
  `,
  );
  const runtime = {
    ...runtimeFor("cursor-bridge"),
    digest,
    installDir: path.join(dataDir, BRIDGE_RUNTIMES_DIRECTORY, "cursor-bridge", digest),
  };
  const marker = path.join(root, `worker-${digest}-${pause}`);
  const child = Bun.spawn(
    [process.execPath, worker, JSON.stringify(runtime), marker, pause ? "pause" : "run"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return { child, marker, runtime };
}

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await fs.readFile(file, "utf8").catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error(`Worker did not write ${file}`);
}

test("independent processes serialize installation and reuse the completed digest", async () => {
  await stageBridge("cursor-bridge", "aaaaaaaaaaaaaaaa");
  const first = await installerWorker("aaaaaaaaaaaaaaaa", true);
  let second: Awaited<ReturnType<typeof installerWorker>> | undefined;
  try {
    const staging = await waitForFile(first.marker + ".staging");
    second = await installerWorker("aaaaaaaaaaaaaaaa", false);
    await waitForFile(second.marker + ".started");
    await Bun.sleep(150);
    expect(await fs.stat(staging).then(() => true)).toBe(true);
    expect(await fs.stat(second.marker + ".staging").catch(() => null)).toBeNull();
    first.child.stdin.end();
    expect(await first.child.exited).toBe(0);
    expect(await second.child.exited).toBe(0);
    expect(isBridgeRuntimeInstalled(second.runtime)).toBe(true);
    // The waiter rechecks the marker after locking and never runs bun again.
    expect(await fs.stat(second.marker + ".staging").catch(() => null)).toBeNull();
  } finally {
    first.child.kill();
    second?.child.kill();
    await Promise.all([first.child.exited, second?.child.exited]);
  }
}, 15_000);

test("a crashed installer releases the lock and its abandoned staging is reclaimed", async () => {
  await stageBridge("cursor-bridge", "bbbbbbbbbbbbbbbb");
  const worker = await installerWorker("bbbbbbbbbbbbbbbb", true);
  try {
    const staging = await waitForFile(worker.marker + ".staging");
    worker.child.kill("SIGKILL");
    await worker.child.exited;
    await ensureBridgeRuntime(worker.runtime, { bun: process.execPath });
    expect(await fs.stat(staging).catch(() => null)).toBeNull();
    expect(isBridgeRuntimeInstalled(worker.runtime)).toBe(true);
  } finally {
    worker.child.kill();
    await worker.child.exited;
  }
}, 15_000);

test("installing a new digest preserves a live prior runtime and its lazy dependencies", async () => {
  await stageBridge("cursor-bridge", "cccccccccccccccc");
  const previous = runtimeFor("cursor-bridge");
  await ensureBridgeRuntime(previous, { bun: process.execPath });
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    await Bun.stdin.text();
    console.log((await import(${JSON.stringify(path.join(previous.installDir, "node_modules/greeting/index.js"))})).greeting);
  `,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    await stageBridge("cursor-bridge", "dddddddddddddddd");
    const installer = await installerWorker("dddddddddddddddd", false);
    try {
      expect(await installer.child.exited).toBe(0);
    } finally {
      installer.child.kill();
      await installer.child.exited;
    }
    child.stdin.end();
    expect((await new Response(child.stdout).text()).trim()).toBe("installed");
    expect(await child.exited).toBe(0);
    expect(isBridgeRuntimeInstalled(previous)).toBe(true);
  } finally {
    child.kill();
    await child.exited;
  }
}, 15_000);

test.each([true, false])(
  "publication collision accepts only a completed runtime (marker=%s)",
  async (complete) => {
    await stageBridge("cursor-bridge", "eeeeeeeeeeeeeeee");
    const runtime = runtimeFor("cursor-bridge");
    const run = (async () => {
      // Simulate an older installer that does not participate in the lock.
      await fs.mkdir(runtime.installDir);
      await fs.writeFile(
        path.join(runtime.installDir, complete ? ".installed" : "partial"),
        "winner",
      );
      return { stdout: "", stderr: "" };
    }) as typeof runCommand;
    const result = ensureBridgeRuntime(runtime, { bun: "bun", run });
    if (complete) {
      expect(await result).toBe(runtime.installDir);
      expect(await fs.readFile(path.join(runtime.installDir, ".installed"), "utf8")).toBe("winner");
    } else {
      await expect(result).rejects.toThrow();
      expect(isBridgeRuntimeInstalled(runtime)).toBe(false);
    }
    expect(
      (await fs.readdir(path.dirname(runtime.installDir))).some((name) =>
        name.startsWith(".staging-"),
      ),
    ).toBe(false);
  },
);
