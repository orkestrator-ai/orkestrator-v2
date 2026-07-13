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
    expect(build).toContain('rmSync(path.join(root, "dist")');
    expect(dev).toContain("vite.kill()");
    expect(dev).toContain('process.on("SIGINT"');
    expect(dev).toContain("Timed out waiting for");
    expect(dev).toContain('electron.on("exit"');
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
  });
});
