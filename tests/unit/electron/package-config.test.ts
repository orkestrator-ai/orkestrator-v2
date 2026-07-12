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
      build: {
        directories: { buildResources: string; output: string };
        files: string[];
        extraResources: Array<{ from: string; to: string; filter: string[] }>;
        mac: { icon: string };
        win: { icon: string };
        linux: { icon: string };
      };
    }>("package.json");
    const electronTsconfig = await readJson<{ compilerOptions: { outDir: string; rootDir: string }; include: string[] }>("apps/desktop/tsconfig.electron.json");

    expect(packageJson.main).toBe("apps/desktop/dist/electron/main.js");
    expect(packageJson.scripts.build).toContain("turbo");
    expect(packageJson.scripts.package).toContain("bun run build:all");
    expect(packageJson.scripts.package).toContain("electron-builder");
    expect(packageJson.build.directories).toMatchObject({ buildResources: "apps/desktop/electron/resources", output: "release" });
    expect(packageJson.build.mac.icon).toBe("icon.icns");
    expect(packageJson.build.win.icon).toBe("icon.ico");
    expect(packageJson.build.linux.icon).toBe("icons");
    expect(packageJson.build.files).toEqual(expect.arrayContaining(["apps/desktop/dist/**", "package.json"]));
    expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "apps/web/dist", to: "web" }),
      expect.objectContaining({ from: "apps/backend/dist", to: "backend" }),
      expect.objectContaining({ from: "bridges/claude-bridge", to: "claude-bridge" }),
      expect.objectContaining({ from: "bridges/codex-bridge", to: "codex-bridge" }),
      expect.objectContaining({ from: "binaries", to: "bin" }),
    ]));
    expect(electronTsconfig.compilerOptions.outDir).toBe("dist");
    expect(electronTsconfig.compilerOptions.rootDir).toBe(".");
    expect(electronTsconfig.include).toEqual(["electron/**/*.ts"]);
  });

  test("keeps valid platform icon resources available to electron-builder", async () => {
    const macIcon = await readResource("icon.icns");
    const windowsIcon = await readResource("icon.ico");
    const sourcePng = await readResource("icon.png");
    const linuxIcon = await readResource("icons/512x512.png");

    expect(macIcon.subarray(0, 4).toString("ascii")).toBe("icns");
    expect([...windowsIcon.subarray(0, 4)]).toEqual([0x00, 0x00, 0x01, 0x00]);
    expectPngSignature(sourcePng);
    expectPngSignature(linuxIcon);
    expect(sourcePng.equals(linuxIcon)).toBe(true);
  });
});
