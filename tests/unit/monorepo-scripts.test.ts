import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("monorepo orchestration scripts", () => {
  test("backend build bundles the entrypoint and vendors Sharp's dynamic native dependencies", () => {
    const source = read("apps/backend/scripts/build.ts");
    expect(source).toContain('entrypoints: [path.join(packageRoot, "src/main.ts")]');
    expect(source).toContain('path.join(output, "node_modules/@img")');
    expect(source).toContain("if (!result.success)");
  });

  test("desktop build and development scripts propagate failures and clean children", () => {
    const build = read("apps/desktop/scripts/build.ts");
    const dev = read("apps/desktop/scripts/dev.ts");
    expect(build).toContain("result.status !== 0");
    expect(build).toContain('run("bunx", ["tsc", "--noEmit"');
    expect(build).toContain("const result = await Bun.build");
    expect(build).toContain('path.join(packageRoot, "electron/main.ts")');
    expect(build).toContain('path.join(packageRoot, "electron/preload.ts")');
    expect(build).toContain('external: ["electron"]');
    expect(build).toContain('target: "node"');
    expect(build).toContain("rmSync(output");
    expect(dev).toContain("vite.kill()");
    expect(dev).toContain('process.on("SIGINT"');
    expect(dev).toContain("Timed out waiting for");
    expect(dev).toContain('electron.on("exit"');
    expect(dev).toContain("handleElectronExit(code, signal");
    expect(build).toContain('process.platform === "win32"');
    expect(dev).toContain('process.platform === "win32"');
  });

  test("desktop packaging and PTY dependencies match the macOS/Linux Bun-only support policy", () => {
    const rootPackage = JSON.parse(read("package.json")) as { build?: Record<string, unknown> };
    const backendPackage = JSON.parse(read("apps/backend/package.json")) as { dependencies?: Record<string, string> };
    const pty = read("apps/backend/src/core/pty.ts");
    expect(rootPackage.build).not.toHaveProperty("win");
    expect(backendPackage.dependencies).not.toHaveProperty("node-pty");
    expect(pty).toContain("Bun.Terminal");
    expect(pty).toContain('platform !== "win32"');
  });

  test("Claude vendoring dereferences the SDK and includes optional platform packages", () => {
    const source = read("bridges/claude-bridge/scripts/vendor.ts");
    expect(source).toContain("await realpath(sdkLink)");
    expect(source).toContain("dereference: true");
    expect(source).toContain('name.startsWith("claude-agent-sdk-")');
  });

  test("Docker builds both bridges with their shared protocol workspace dependency", () => {
    const source = read("docker/Dockerfile");
    const install = "RUN bun install --filter claude-bridge --filter codex-bridge";
    const installIndex = source.indexOf(install);

    expect(installIndex).toBeGreaterThan(-1);
    expect(source.indexOf("COPY --chown=node:node package.json bun.lock /opt/bridge-build/"))
      .toBeLessThan(installIndex);
    expect(source.indexOf(
      "COPY --chown=node:node packages/protocol /opt/bridge-build/packages/protocol",
    )).toBeLessThan(installIndex);
    expect(source.indexOf(
      "COPY --chown=node:node bridges/claude-bridge /opt/bridge-build/bridges/claude-bridge",
    )).toBeLessThan(installIndex);
    expect(source.indexOf(
      "COPY --chown=node:node bridges/codex-bridge /opt/bridge-build/bridges/codex-bridge",
    )).toBeLessThan(installIndex);
    expect(source).toContain(
      "mv /opt/bridge-build/bridges/claude-bridge /opt/claude-bridge",
    );
    expect(source).toContain(
      "mv /opt/bridge-build/bridges/codex-bridge /opt/codex-bridge",
    );
  });

  test("CLI build cache includes every source tree bundled from outside its workspace", () => {
    const turbo = JSON.parse(read("packages/cli/turbo.json")) as {
      tasks?: Record<string, { inputs?: string[] }>;
    };
    const inputs = turbo.tasks?.build?.inputs ?? [];

    expect(inputs).toContain("$TURBO_DEFAULT$");
    for (const externalInput of [
      "$TURBO_ROOT$/tsconfig.json",
      "$TURBO_ROOT$/apps/backend/package.json",
      "$TURBO_ROOT$/apps/backend/tsconfig.json",
      "$TURBO_ROOT$/apps/backend/src/**",
      "$TURBO_ROOT$/bridges/claude-bridge/package.json",
      "$TURBO_ROOT$/bridges/claude-bridge/tsconfig.json",
      "$TURBO_ROOT$/bridges/claude-bridge/src/**",
      "$TURBO_ROOT$/bridges/codex-bridge/package.json",
      "$TURBO_ROOT$/bridges/codex-bridge/tsconfig.json",
      "$TURBO_ROOT$/bridges/codex-bridge/src/**",
      "$TURBO_ROOT$/packages/protocol/package.json",
      "$TURBO_ROOT$/packages/protocol/tsconfig.json",
      "$TURBO_ROOT$/packages/protocol/src/**",
    ]) {
      expect(inputs).toContain(externalInput);
    }
  });

  test("full tests run workspace, root, bridge, and protocol checks concurrently", () => {
    // The groups are independent, so they run at once rather than in sequence.
    // Behaviour is asserted properly in tests/unit/test-all.test.ts; this only
    // pins the shape of the orchestration.
    const source = read("scripts/test-all.ts");
    expect(source).toContain("Promise.all(");
    expect(source).toContain('"--filter=@orkestrator/web-public"');
    expect(source).toContain('"--filter=orkestrator"');
    expect(source).toContain('args: ["run", "codex:protocol:check"]');
    expect(source).toContain('args: ["scripts/test-ios.ts"]');
    expect(source).toContain('dependencies.platform === "darwin"');
    expect(source).toContain("process.exit(status)");
    // A signal-terminated group (null status) must count as a failure.
    expect(source).toContain("result.status ?? 1");
  });

  test("full tests report every failing group instead of stopping at the first", () => {
    // With concurrency the other groups have already run, so surfacing them all
    // avoids a second full run just to see the next failure.
    const source = read("scripts/test-all.ts");
    expect(source).toContain("Failing groups:");
  });

  test("full tests cover the bridge packages, which have no workspace test script", () => {
    // bridges/* are not in the turbo `test:workspace` filters and declare no
    // `test` script, so they only run if test-all.ts invokes them directly.
    const source = read("scripts/test-all.ts");
    expect(source).toContain('args: ["test", "bridges"');

    for (const bridge of ["bridges/claude-bridge/package.json", "bridges/codex-bridge/package.json"]) {
      const scripts = (JSON.parse(read(bridge)) as { scripts?: Record<string, string> }).scripts ?? {};
      expect(scripts.test).toBeUndefined();
    }
  });

  test("test runners are configured to run test files in parallel", () => {
    // The suite is dominated by I/O waits, so file-level parallelism is where the
    // wall-clock win comes from. The workspace scripts take their bound from
    // ORKESTRATOR_TEST_WORKERS, which test-all sets for the Turbo group, and fall
    // back to a fixed count so a bare `bun run test:workspace` still works.
    const source = read("scripts/test-all.ts");
    expect(source).toContain("--parallel=");
    expect(source).toContain("ORKESTRATOR_TEST_WORKERS");

    for (const pkg of [
      "apps/web/package.json",
      "apps/backend/package.json",
      "apps/web-public/package.json",
      "packages/cli/package.json",
    ]) {
      const scripts = (JSON.parse(read(pkg)) as { scripts?: Record<string, string> }).scripts ?? {};
      expect(scripts.test).toContain("--parallel");
      expect(scripts["test:workspace"]).toContain("--parallel=${ORKESTRATOR_TEST_WORKERS:-2}");
    }
  });

  test("the workspace worker count is never passed through Turbo's `--` separator", () => {
    // Turbo hashes passthrough arguments into the requested task *and its
    // dependencies*, so `-- --parallel=N` gave `bun run build` and `bun run test`
    // different `#build` hashes and re-ran `tsc && vite build` on every
    // alternation between the two commands.
    const source = read("scripts/test-all.ts");
    expect(source).not.toContain('"--",');

    const turbo = JSON.parse(read("turbo.json")) as {
      tasks?: Record<string, { passThroughEnv?: string[]; env?: string[] }>;
    };
    const workspaceTask = turbo.tasks?.["test:workspace"] ?? {};
    // passThroughEnv, not env: the worker count must reach the task without
    // becoming part of its hash.
    expect([
      ...(workspaceTask.passThroughEnv ?? []),
      ...(workspaceTask.env ?? []),
    ]).toContain("ORKESTRATOR_TEST_WORKERS");
    expect(workspaceTask.env ?? []).not.toContain("ORKESTRATOR_TEST_WORKERS");
  });

  test("iOS development and test scripts use Bun entrypoints", () => {
    const rootPackage = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    expect(rootPackage.scripts?.["dev:ios"]).toBe("bun scripts/run-ios-simulator.ts");
    expect(rootPackage.scripts?.["test:ios"]).toBe("bun scripts/test-ios.ts");
  });
});
