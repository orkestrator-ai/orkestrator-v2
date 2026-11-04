import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RENDERER_CONTENT_SECURITY_POLICY } from "@orkestrator/protocol/renderer-content-security-policy";
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
    expect(rendererSecurityPlugin().apply).toBe("build");
  });
});
