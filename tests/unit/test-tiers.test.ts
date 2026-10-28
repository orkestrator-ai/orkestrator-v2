import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { slowTestFiles, testTier, tierArguments, type TestTier } from "../../scripts/test-tiers";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const temporaryRoots: string[] = [];

function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "test-tier-fixture-"));
  temporaryRoots.push(root);
  const write = (file: string, value: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  for (const [file, value] of Object.entries(files)) write(file, value);
  return { root, write };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("test tier selection", () => {
  test("defaults only an absent or empty tier and rejects invalid values", () => {
    expect(testTier({})).toBe("default");
    expect(testTier({ ORKESTRATOR_TEST_TIER: "" })).toBe("default");
    for (const tier of ["default", "slow", "all"] as const)
      expect(testTier({ ORKESTRATOR_TEST_TIER: tier })).toBe(tier);
    expect(() => testTier({ ORKESTRATOR_TEST_TIER: "quick" })).toThrow(
      "ORKESTRATOR_TEST_TIER must be one of default, slow, all",
    );
  });

  test("slow discovery is sorted, deduplicated and excludes dependency directories", () => {
    const { root } = fixture({
      "apps/backend/tests/tmux-live.test.ts": "",
      "apps/backend/src/nested/example.live.test.ts": "",
      "apps/backend/src/kept.test.ts": "",
      "apps/backend/node_modules/dependency/example.live.test.ts": "",
    });
    expect(slowTestFiles(root, "apps/backend")).toEqual([
      "src/nested/example.live.test.ts",
      "tests/tmux-live.test.ts",
    ]);
  });

  test("slow discovery respects directories, individual files and path boundaries", () => {
    const { root } = fixture({
      "apps/backend/src/core/a.live.test.ts": "",
      "apps/backend/src/core/nested/b.integration.test.ts": "",
      "apps/backend/src/core-extra/c.live.test.ts": "",
      "apps/backend/tests/tmux.test.ts": "",
    });
    expect(tierArguments("slow", root, "apps/backend", ["./src/core/"])).toEqual([
      "./src/core/a.live.test.ts",
      "./src/core/nested/b.integration.test.ts",
    ]);
    expect(tierArguments("slow", root, "apps/backend", ["./src/core/a.live.test.ts"])).toEqual([
      "./src/core/a.live.test.ts",
    ]);
    expect(tierArguments("slow", root, "apps/backend", ["."])).toHaveLength(4);
    expect(tierArguments("slow", root, "apps/backend", ["src/missing"])).toBeUndefined();
  });

  test("packages with no slow files preserve normal selectors and skip an empty slow tier", () => {
    const { root } = fixture({ "packages/toolchain/src/kept.test.ts": "" });
    const selectors = ["./src"];
    expect(tierArguments("slow", root, "packages/toolchain", selectors)).toBeUndefined();
    for (const tier of ["default", "all"] as const) {
      const args = tierArguments(tier, root, "packages/toolchain", selectors);
      expect(args).toEqual(selectors);
      expect(args).not.toBe(selectors);
    }
    expect(selectors).toEqual(["./src"]);
  });
});

function packageFixture() {
  const context = fixture();
  context.write("scripts/placeholder", "");
  for (const file of ["bun-test-tier.ts", "test-tiers.ts"])
    copyFileSync(
      path.join(repositoryRoot, "scripts", file),
      path.join(context.root, "scripts", file),
    );
  const manifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, "apps/backend/package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  context.write(
    "apps/backend/package.json",
    JSON.stringify({ scripts: { "test:workspace": manifest.scripts["test:workspace"] } }),
  );
  context.write("tests/setup-node.ts", 'process.env.TIER_PRELOAD_PROBE = "loaded";');
  return {
    ...context,
    cwd: path.join(context.root, "apps/backend"),
    environment(tier: string = "all"): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = { ...process.env, ORKESTRATOR_TEST_TIER: tier };
      for (const name of ["NODE_ENV", "TIER_DOTENV_PROBE", "TIER_PRELOAD_PROBE"]) delete env[name];
      return {
        ...env,
        ORKESTRATOR_TEST_TIMINGS_DIR: "",
        ORKESTRATOR_BACKEND_TEST_WORKERS: "1",
      };
    },
  };
}

function selectedTest(name: string) {
  return `import { expect, test } from "bun:test";
test(${JSON.stringify(name)}, () => {
  expect(process.env.NODE_ENV).toBe("test");
  expect(process.env.TIER_DOTENV_PROBE).toBe("test");
  expect(process.env.TIER_PRELOAD_PROBE).toBe("loaded");
  console.log(${JSON.stringify("SELECTED:" + name)});
});`;
}

describe("package tier wrapper", () => {
  test("every package starts the wrapper without loading dotenv first", () => {
    const manifests = new Bun.Glob("{apps,bridges,packages}/*/package.json").scanSync({
      cwd: repositoryRoot,
    });
    let wrappers = 0;
    for (const file of manifests) {
      const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, file), "utf8")) as {
        scripts?: Record<string, string>;
      };
      for (const command of Object.values(manifest.scripts ?? {})) {
        if (!command.includes("/bun-test-tier.ts")) continue;
        expect(command, file).toStartWith("bun --no-env-file ../../scripts/bun-test-tier.ts ");
        wrappers++;
      }
    }
    expect(wrappers).toBeGreaterThan(0);
  });

  test("the package command partitions tiers and leaves dotenv loading to bun test", () => {
    const context = packageFixture();
    context.write("apps/backend/.env", "TIER_DOTENV_PROBE=development\n");
    context.write("apps/backend/.env.test", "TIER_DOTENV_PROBE=test\n");
    const files = {
      "src/kept.test.ts": "kept",
      "tests/kept.test.ts": "tests",
      "src/core/review-validation-worker.test.ts": "slow",
      "src/nested/example.live.test.ts": "live",
    };
    for (const [file, name] of Object.entries(files))
      context.write(`apps/backend/${file}`, selectedTest(name));
    const selected: Record<TestTier, string[]> = { default: [], slow: [], all: [] };
    for (const tier of ["default", "slow", "all"] as const) {
      const child = spawnSync(process.execPath, ["--no-env-file", "run", "test:workspace"], {
        cwd: context.cwd,
        env: context.environment(tier),
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(child.status, child.stdout + child.stderr).toBe(0);
      selected[tier] = child.stdout
        .split("\n")
        .filter((line) => line.startsWith("SELECTED:"))
        .map((line) => line.slice("SELECTED:".length))
        .sort();
    }
    expect(selected.default).toEqual(["kept", "tests"]);
    expect(selected.slow).toEqual(["live", "slow"]);
    expect(selected.all).toEqual([...selected.default, ...selected.slow].sort());
  });

  test("an empty slow tier succeeds without running ordinary tests", () => {
    const context = packageFixture();
    context.write("apps/backend/src/kept.test.ts", 'throw new Error("must not run");');
    context.write("apps/backend/tests/kept.test.ts", 'throw new Error("must not run");');
    const child = spawnSync(process.execPath, ["--no-env-file", "run", "test:workspace"], {
      cwd: context.cwd,
      env: context.environment("slow"),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stdout).toContain("No slow-tier tests in apps/backend.");
  });

  test("explicit caller environment values still override dotenv files", () => {
    const context = packageFixture();
    context.write("apps/backend/.env", "TIER_DOTENV_PROBE=development\n");
    context.write("apps/backend/.env.test", "TIER_DOTENV_PROBE=test\n");
    context.write(
      "apps/backend/src/environment.test.ts",
      'import { expect, test } from "bun:test"; test("caller override", () => expect(process.env.TIER_DOTENV_PROBE).toBe("caller"));',
    );
    context.write("apps/backend/tests/placeholder", "");
    const child = spawnSync(process.execPath, ["--no-env-file", "run", "test:workspace"], {
      cwd: context.cwd,
      env: { ...context.environment(), TIER_DOTENV_PROBE: "caller" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.status, child.stdout + child.stderr).toBe(0);
  });

  test("a failing child fails the package command with its diagnostics", () => {
    const context = packageFixture();
    context.write(
      "apps/backend/src/fail.test.ts",
      'import { test } from "bun:test"; test("fixture failure", () => { throw new Error("tier failure probe"); });',
    );
    context.write("apps/backend/tests/placeholder", "");
    const child = spawnSync(process.execPath, ["--no-env-file", "run", "test:workspace"], {
      cwd: context.cwd,
      env: context.environment(),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.status).toBe(1);
    expect(child.stdout + child.stderr).toContain("tier failure probe");
  });

  test("invalid tier and missing selectors fail before any test starts", () => {
    const context = packageFixture();
    context.write("apps/backend/src/kept.test.ts", 'throw new Error("must not run");');
    const invalid = spawnSync(process.execPath, ["--no-env-file", "run", "test:workspace"], {
      cwd: context.cwd,
      env: context.environment("unknown"),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout + invalid.stderr).toContain("ORKESTRATOR_TEST_TIER must be one of");
    const missing = spawnSync(
      process.execPath,
      ["--no-env-file", "../../scripts/bun-test-tier.ts", "apps/backend", "--"],
      { cwd: context.cwd, env: context.environment(), encoding: "utf8", timeout: 10_000 },
    );
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("Usage:");
  });

  // Windows does not implement these Unix process-group signal semantics.
  test.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "%s reaches the child and waits for its cleanup",
    async (signal) => {
      const context = packageFixture();
      const ready = path.join(context.root, "ready");
      const handled = path.join(context.root, "handled");
      context.write(
        "apps/backend/src/signal.test.ts",
        `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
process.on(${JSON.stringify(signal)}, () => {
  writeFileSync(${JSON.stringify(handled)}, ${JSON.stringify(signal)});
  process.exit(0);
});
test("wait for cancellation", async () => {
  writeFileSync(${JSON.stringify(ready)}, "ready");
  await new Promise(() => {});
}, 30000);`,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "../../scripts/bun-test-tier.ts",
          "apps/backend",
          "./src",
          "--",
        ],
        // Use one child process to isolate the wrapper's forwarding from Bun's
        // worker-pool signal behavior. The fixture group is always cleaned up.
        {
          cwd: context.cwd,
          env: context.environment(),
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        },
      );
      const output = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      try {
        const deadline = Date.now() + 5000;
        while (!existsSync(ready) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(existsSync(ready)).toBe(true);
        child.kill(signal);
        const exited = await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            const timeout = setTimeout(() => reject(new Error("child did not stop")), 5000);
            child.exited.finally(() => clearTimeout(timeout));
          }),
        ]);
        expect(exited).toBe(0);
        expect(readFileSync(handled, "utf8")).toBe(signal);
      } finally {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        await child.exited;
        await output;
      }
    },
    15_000,
  );
});
