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

  test("full tests stop on workspace failure before running root tests", () => {
    const source = read("scripts/test-all.ts");
    const workspaceRun = source.indexOf('run("turbo"');
    const rootRun = source.indexOf('run("bun", ["test", "tests"]');
    expect(workspaceRun).toBeGreaterThan(-1);
    expect(rootRun).toBeGreaterThan(workspaceRun);
    expect(source).toContain("process.exit(result.status ?? 1)");
    expect(source).toContain('"--filter=@orkestrator/web-public"');
  });
});
