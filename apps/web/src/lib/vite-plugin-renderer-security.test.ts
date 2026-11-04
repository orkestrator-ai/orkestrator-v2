import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  DESIGN_FRAME_DOCUMENT,
  RENDERER_CONTENT_SECURITY_POLICY,
} from "@orkestrator/protocol/renderer-content-security-policy";
import {
  rendererSecurityPlugin,
  withRendererContentSecurityPolicy,
} from "../../vite-plugin-renderer-security";

const indexHtml = readFileSync(path.resolve(import.meta.dir, "../../index.html"), "utf8");

describe("renderer security build plugin", () => {
  test("places the policy in the real index.html ahead of anything it governs", () => {
    const html = withRendererContentSecurityPolicy(indexHtml);
    const tag = `<meta http-equiv="Content-Security-Policy" content="${RENDERER_CONTENT_SECURITY_POLICY}" />`;
    expect(html).toContain(tag);
    expect(html.indexOf('<meta charset="UTF-8"')).toBeLessThan(html.indexOf(tag));
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf("<script"));
  });

  test("fails the build rather than shipping a document with no policy", () => {
    expect(() => withRendererContentSecurityPolicy("<html><head></head></html>")).toThrow(
      "charset",
    );
  });

  test("leaves the dev server alone, whose React preamble is an inline script", () => {
    const plugin = rendererSecurityPlugin();
    expect(plugin.apply).toBe("build");
    if (typeof plugin.config !== "function") throw new Error("Expected config hook");
    expect(plugin.config.call({} as never, {}, {} as never)).toEqual({
      define: {
        "import.meta.env.ORKESTRATOR_DESIGN_FRAME_DOCUMENT": JSON.stringify(DESIGN_FRAME_DOCUMENT),
      },
    });
  });
});

test("generateBundle uses runnerImport and emits a hash-pinned production design document", async () => {
  const plugin = rendererSecurityPlugin();
  const emitted: Array<{ type: string; fileName: string; source: string }> = [];
  const hook = plugin.generateBundle;
  if (typeof hook !== "function") throw new Error("Expected generateBundle hook");
  await hook.call(
    {
      emitFile: (asset: any) => {
        emitted.push(asset);
        return "asset";
      },
    } as never,
    {} as never,
    {},
    false,
  );
  expect(emitted).toHaveLength(1);
  const asset = emitted[0]!;
  expect(asset.fileName).toBe(DESIGN_FRAME_DOCUMENT);
  expect(asset.type).toBe("asset");
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(asset.source)?.[1];
  expect(script).toBeDefined();
  const hash = createHash("sha256").update(script!).digest("base64");
  expect(asset.source).toContain(`'sha256-${hash}'`);
  expect(asset.source).not.toContain("script-src 'unsafe-inline'");
});
