import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");

describe("remote gateway documentation", () => {
  test("keeps README and detailed docs aligned with the managed Electron workflow", async () => {
    const [readme, guide] = await Promise.all([
      readFile(path.join(root, "README.md"), "utf8"),
      readFile(path.join(root, "docs", "remote-gateway.md"), "utf8"),
    ]);

    for (const document of [readme, guide]) {
      expect(document).toContain("Settings > Web client");
      expect(document).toContain("Allow web access");
      expect(document).toContain("Tailscale Serve");
      expect(document).toContain("www.orkestrator.dev");
    }
    expect(readme).toContain("bun run start:web-public");
    expect(guide).toContain("--tailscale-serve");
    expect(guide).toContain("Disabling the setting removes that Serve endpoint");
  });

  test("references an existing standalone command and syntactically valid HTTPS links", async () => {
    const [manifest, readme, guide] = await Promise.all([
      Bun.file(path.join(root, "package.json")).json() as Promise<{ scripts?: Record<string, string> }>,
      readFile(path.join(root, "README.md"), "utf8"),
      readFile(path.join(root, "docs", "remote-gateway.md"), "utf8"),
    ]);

    expect(manifest.scripts?.["start:web-public"]).toBeTruthy();
    for (const document of [readme, guide]) {
      for (const match of document.matchAll(/\]\((https:\/\/[^)]+)\)/g)) {
        expect(() => new URL(match[1])).not.toThrow();
      }
    }
  });
});
