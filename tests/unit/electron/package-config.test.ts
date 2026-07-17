import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(process.cwd(), relativePath), "utf8")) as T;
}

async function readResource(relativePath: string): Promise<Buffer> {
  return fs.readFile(path.join(process.cwd(), "apps/desktop/electron/resources", relativePath));
}

function expectPngSignature(bytes: Buffer): void {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

describe("Electron packaging configuration", () => {
  test("keeps package entry points and package files aligned with the Electron build output", async () => {
    const packageJson = await readJson<{
      main: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      build: {
        directories: { buildResources: string; output: string };
        files: string[];
        extraResources: Array<{ from: string; to: string; filter: string[] }>;
        mac: { icon: string };
        win?: { icon: string };
        linux: { icon: string };
      };
    }>("package.json");
    const electronTsconfig = await readJson<{ compilerOptions: { outDir: string; rootDir: string }; include: string[] }>("apps/desktop/tsconfig.electron.json");
    const desktopBuildScript = await fs.readFile(path.join(process.cwd(), "apps/desktop/scripts/build.ts"), "utf8");
    const bootstrapPreload = await fs.readFile(path.join(process.cwd(), "apps/desktop/electron/toolchain-bootstrap-preload.ts"), "utf8");
    const desktopMain = await fs.readFile(path.join(process.cwd(), "apps/desktop/electron/main.ts"), "utf8");

    expect(packageJson.main).toBe("apps/desktop/dist/electron/main.js");
    expect(packageJson.scripts.build).toContain("turbo");
    expect(packageJson.scripts.package).toContain("bun run download:bun");
    expect(packageJson.scripts.package).toContain("bun run build:all");
    expect(packageJson.scripts.package).toContain("electron-builder");
    expect(packageJson.scripts.setup).not.toContain("download:binaries");
    expect(packageJson.scripts["build:all"]).not.toContain("download:binaries");
    expect(packageJson.scripts["docker:build"]).not.toContain("--no-cache");
    expect(packageJson.devDependencies.electron).toBeDefined();
    expect(packageJson.build.directories).toMatchObject({ buildResources: "apps/desktop/electron/resources", output: "release" });
    expect(packageJson.build.mac.icon).toBe("icon.icns");
    expect(packageJson.build.win).toBeUndefined();
    expect(packageJson.build.linux.icon).toBe("icons");
    expect(packageJson.build.files).toEqual(expect.arrayContaining(["apps/desktop/dist/**", "package.json"]));
    expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "apps/web/dist", to: "web" }),
      expect.objectContaining({ from: "apps/backend/dist", to: "backend" }),
      expect.objectContaining({ from: "bridges/claude-bridge", to: "claude-bridge" }),
      expect.objectContaining({ from: "bridges/codex-bridge", to: "codex-bridge" }),
      expect.objectContaining({ from: "binaries", to: "bin", filter: ["bun"] }),
    ]));
    expect(electronTsconfig.compilerOptions.outDir).toBe("dist");
    expect(electronTsconfig.compilerOptions.rootDir).toBe(".");
    expect(electronTsconfig.include).toEqual(["electron/**/*.ts"]);
    expect(desktopBuildScript).toContain('path.join(packageRoot, "electron/toolchain-bootstrap-preload.ts")');
    expect(bootstrapPreload).toContain('ipcRenderer.on("orkestrator:toolchain-progress"');
    expect(bootstrapPreload).toContain('window.addEventListener("DOMContentLoaded"');
    expect(desktopMain).toContain("createToolchainProgressController");
    expect(desktopMain).toContain("await toolchainProgress.close()");
  });

  test("uses the Bun-based container image before running the simplified workspace setup", async () => {
    const workspaceConfig = await readJson<{ setupContainer: string[] }>("orkestrator-ai.json");
    const dockerfile = await fs.readFile(path.join(process.cwd(), "docker/Dockerfile"), "utf8");

    expect(workspaceConfig.setupContainer).toEqual(["bun install"]);
    expect(dockerfile).toMatch(/^FROM oven\/bun:/m);
  });

  test("keeps valid macOS and Linux icon resources available to electron-builder", async () => {
    const macIcon = await readResource("icon.icns");
    const sourcePng = await readResource("icon.png");
    const linuxIcon = await readResource("icons/512x512.png");

    expect(macIcon.subarray(0, 4).toString("ascii")).toBe("icns");
    expectPngSignature(sourcePng);
    expectPngSignature(linuxIcon);
    expect(sourcePng.equals(linuxIcon)).toBe(true);
  });
});
