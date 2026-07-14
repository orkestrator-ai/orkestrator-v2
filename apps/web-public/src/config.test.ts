import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const read = (name: string) => readFileSync(path.join(packageRoot, name), "utf8");

describe("public client deployment configuration", () => {
  test("builds and tests as an isolated Bun workspace", () => {
    const manifest = JSON.parse(read("package.json")) as { name: string; scripts: Record<string, string> };
    expect(manifest.name).toBe("@orkestrator/web-public");
    expect(manifest.scripts.build).toContain("tsc");
    expect(manifest.scripts.build).toContain("vite build");
    expect(manifest.scripts["test:workspace"]).toBe("bun test src");

    const tsconfig = JSON.parse(read("tsconfig.json")) as { compilerOptions: { strict: boolean; paths: unknown } };
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.paths).toBeDefined();
    expect(read("vite.config.ts")).toContain('"@": path.resolve(__dirname, "../web/src")');
    expect(read("bunfig.toml")).toContain('preload = ["../../tests/setup.ts"]');
  });

  test("serves the SPA without proxying backend traffic and applies browser hardening headers", () => {
    const config = JSON.parse(read("vercel.json")) as {
      outputDirectory: string;
      rewrites: Array<{ source: string; destination: string }>;
      headers: Array<{ headers: Array<{ key: string; value: string }> }>;
    };
    expect(config.outputDirectory).toBe("dist");
    expect(config.rewrites).toEqual([{ source: "/(.*)", destination: "/index.html" }]);
    const headers = config.headers.flatMap((entry) => entry.headers);
    expect(headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
    expect(headers).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" });

    const csp = headers.find((header) => header.key === "Content-Security-Policy")?.value;
    if (!csp) throw new Error("Expected a Content-Security-Policy header");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // The user picks the backend origin at runtime, so connect-src must allow HTTPS broadly.
    expect(csp).toContain("connect-src 'self' https: wss:");
    expect(read("index.html")).toContain('<script type="module" src="/src/main.tsx"></script>');
  });
});
