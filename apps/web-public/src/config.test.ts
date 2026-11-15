import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY,
  STATIC_HTML_FRAME_DOCUMENT,
} from "@orkestrator/protocol/renderer-content-security-policy";
import {
  type VercelConfig,
  vercelHeadersFor,
  vercelRewriteFor,
  vercelSourcePattern,
} from "../vercel-routing";

const packageRoot = path.resolve(import.meta.dir, "..");
const read = (name: string) => readFileSync(path.join(packageRoot, name), "utf8");
const readSharedWeb = (name: string) =>
  readFileSync(path.join(packageRoot, "../web", name), "utf8");

describe("public client deployment configuration", () => {
  test("builds and tests as an isolated Bun workspace", () => {
    const manifest = JSON.parse(read("package.json")) as {
      name: string;
      scripts: Record<string, string>;
    };
    expect(manifest.name).toBe("@orkestrator/web-public");
    expect(manifest.scripts.build).toContain("bun check");
    expect(manifest.scripts.build).toContain("vite build");
    // scripts/test-all.ts supplies the worker count through the environment so
    // every package task shares the aggregate budget. It deliberately does not
    // use Turbo's `--` separator, which would fold into the dependency `build`
    // task's hash and split the cache between `bun run build` and `bun run test`.
    expect(manifest.scripts["test:workspace"]).toBe(
      "bun --no-env-file ../../scripts/bun-test-tier.ts apps/web-public src -- --only-failures ${ORKESTRATOR_TEST_TIMINGS_DIR:+--timings=$ORKESTRATOR_TEST_TIMINGS_DIR/web-public.json --update-timings} --parallel=${ORKESTRATOR_TEST_WORKERS:-2}",
    );

    const tsconfig = JSON.parse(read("tsconfig.json")) as {
      compilerOptions: { strict: boolean; paths: unknown };
    };
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.paths).toBeDefined();
    expect(read("vite.config.ts")).toContain(
      '"@": path.resolve(import.meta.dirname, "../web/src")',
    );
    expect(read("bunfig.toml")).toContain(
      'preload = ["../../tests/register-dom.ts", "../../tests/setup.ts"]',
    );
    expect(readSharedWeb("src/index.css")).toContain('@source "./"');
  });

  test("serves the SPA without proxying backend traffic and applies browser hardening headers", () => {
    const config = readVercelConfig();
    expect(config.outputDirectory).toBe("dist");
    expect(config.rewrites).toEqual([{ source: "/(.*)", destination: "/index.html" }]);
    for (const probe of ["/", "/connect", "/connect/", "/static-html-frame.html"]) {
      expect(vercelRewriteFor(config, probe)).toBe("/index.html");
    }
    for (const probe of ["/", "/index.html", "/assets/index-abc.js", "/static-html-frame.html"]) {
      const headers = vercelHeadersFor(config, probe);
      expect(headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
      expect(headers).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" });
    }

    const csp = appPolicy(config);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // The user picks the backend origin at runtime, so connect-src must allow HTTPS broadly.
    expect(csp).toContain("connect-src 'self' https: wss:");
    expect(read("index.html")).toContain('<script type="module" src="/src/main.tsx"></script>');
  });

  test("serves the static document frame under its own sandboxed rule and nothing else", () => {
    const config = readVercelConfig();
    const framePath = `/${STATIC_HTML_FRAME_DOCUMENT}`;
    // A second matching policy would be enforced as well, and its `script-src
    // 'self'` would refuse the frame's hash-pinned bootstrap.
    expect(policiesFor(config, framePath)).toEqual([GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY]);

    // Every other path, including ones that only resemble the frame's, gets
    // exactly the strict application policy and never the sandbox one as well.
    // The trailing-slash and uppercase forms are different paths to Vercel
    // (strict, case-sensitive matching) and are served the application shell.
    for (const probe of [
      "/",
      "/index.html",
      "/releases",
      "/connect/",
      "/connect/deep/route",
      "/assets/index-abc.js",
      "/design-frame.html",
      `${framePath}/`,
      `${framePath}/nested`,
      `${framePath}x`,
      framePath.toUpperCase(),
      `${framePath.toUpperCase()}/`,
      `/x${framePath}`,
      `/assets${framePath}`,
      "/static-html-frameXhtml",
    ]) {
      expect({ probe, policies: policiesFor(config, probe) }).toEqual({
        probe,
        policies: [appPolicy(config)],
      });
    }
  });

  test("matches header sources the way Vercel compiles them: strict and case-sensitive", () => {
    // `sourceToRegex` in @vercel/routing-utils passes `strict: true, sensitive: true`.
    const frame = vercelSourcePattern(`/${STATIC_HTML_FRAME_DOCUMENT}`);
    expect(frame.test(`/${STATIC_HTML_FRAME_DOCUMENT}`)).toBe(true);
    expect(frame.test(`/${STATIC_HTML_FRAME_DOCUMENT}/`)).toBe(false);
    expect(frame.test(`/${STATIC_HTML_FRAME_DOCUMENT.toUpperCase()}`)).toBe(false);
    const anyPath = vercelSourcePattern("/(.*)");
    for (const probe of ["/", "/connect", "/connect/", "/a/b/"]) {
      expect(anyPath.test(probe)).toBe(true);
    }
    expect(vercelSourcePattern("/assets/(.*)").test("/Assets/x.js")).toBe(false);
  });

  test("the hosted build emits the frame document instead of declaring the view unavailable", () => {
    const viteConfig = read("vite.config.ts");
    expect(viteConfig).toContain(
      'import { staticHtmlFramePlugin } from "../web/vite-plugin-renderer-security";',
    );
    expect(viteConfig).toContain("staticHtmlFramePlugin()");
    expect(viteConfig).not.toContain("ORKESTRATOR_STATIC_HTML_PRESENTATION");
  });
});

function readVercelConfig(): VercelConfig {
  return JSON.parse(read("vercel.json")) as VercelConfig;
}

function policiesFor(config: VercelConfig, pathname: string): string[] {
  return vercelHeadersFor(config, pathname)
    .filter((header) => header.key === "Content-Security-Policy")
    .map((header) => header.value);
}

function appPolicy(config: VercelConfig): string {
  const [policy, ...others] = policiesFor(config, "/");
  if (!policy || others.length > 0) throw new Error("Expected one policy for /");
  return policy;
}
