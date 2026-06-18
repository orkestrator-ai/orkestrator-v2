import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(process.cwd(), relativePath), "utf8")) as T;
}

describe("Electron packaging configuration", () => {
  test("keeps package entry points and package files aligned with the Electron build output", async () => {
    const packageJson = await readJson<{
      main: string;
      scripts: Record<string, string>;
      build: { files: string[]; extraResources: Array<{ from: string; to: string; filter: string[] }> };
    }>("package.json");
    const electronTsconfig = await readJson<{ compilerOptions: { outDir: string; rootDir: string }; include: string[] }>("tsconfig.electron.json");

    expect(packageJson.main).toBe("dist-electron/electron/main.js");
    expect(packageJson.scripts.build).toBe("bun run build:renderer && bun run build:electron");
    expect(packageJson.scripts.package).toContain("bun run build:all");
    expect(packageJson.scripts.package).toContain("electron-builder");
    expect(packageJson.build.files).toEqual(expect.arrayContaining(["dist/**", "dist-electron/**", "package.json"]));
    expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "bridges/claude-bridge", to: "claude-bridge" }),
      expect.objectContaining({ from: "bridges/codex-bridge", to: "codex-bridge" }),
      expect.objectContaining({ from: "binaries", to: "bin" }),
    ]));
    expect(electronTsconfig.compilerOptions.outDir).toBe("dist-electron");
    expect(electronTsconfig.compilerOptions.rootDir).toBe(".");
    expect(electronTsconfig.include).toEqual(expect.arrayContaining(["electron/**/*.ts", "scripts/electron-dev.ts"]));
  });
});
