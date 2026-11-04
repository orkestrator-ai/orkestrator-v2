import { describe, expect, test } from "bun:test";
import {
  DESIGN_FRAME_DOCUMENT,
  GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY,
  GATEWAY_LOGIN_CONTENT_SECURITY_POLICY,
  GATEWAY_RENDERER_CONTENT_SECURITY_POLICY,
} from "@orkestrator/protocol/renderer-content-security-policy";
import {
  createRendererRoot,
  createTempDir,
  requestUrl,
  startGateway,
  writeRendererAsset,
} from "./gateway-test-harness.js";

async function servedGateway() {
  const dataDir = await createTempDir("ork-static-security-");
  const rendererRoot = await createRendererRoot(dataDir, "<!doctype html><title>index</title>");
  await writeRendererAsset(rendererRoot, "assets/app-12345678.js", "console.log('asset');");
  await writeRendererAsset(rendererRoot, DESIGN_FRAME_DOCUMENT, "<!doctype html>");
  // Uppercase fixture names also exercise this on case-sensitive CI filesystems.
  await writeRendererAsset(rendererRoot, "INDEX.HTML", "<!doctype html>");
  await writeRendererAsset(rendererRoot, "DESIGN-FRAME.HTML", "<!doctype html>");
  const { info } = await startGateway({ dataDir, rendererRoot, compression: "off" });
  const get = (pathname: string, headers: Record<string, string> = {}) =>
    requestUrl(`${info.url}${pathname}`, {
      headers: { authorization: `Bearer ${info.token}`, ...headers },
    });
  return { get, info };
}

describe("gateway document Content Security Policy", () => {
  test("the renderer document carries the policy on every path that serves it", async () => {
    const { get } = await servedGateway();
    for (const pathname of ["", "index.html", "INDEX.HTML", "dashboard"]) {
      const response = await get(pathname);
      expect(response.status).toBe(200);
      expect(response.headers["content-security-policy"]).toBe(
        GATEWAY_RENDERER_CONTENT_SECURITY_POLICY,
      );
    }
  });

  test("a revalidated document keeps it", async () => {
    const { get } = await servedGateway();
    const first = await get("");
    const notModified = await get("", { "if-none-match": String(first.headers.etag) });
    expect(notModified.status).toBe(304);
    expect(notModified.headers["content-security-policy"]).toBe(
      GATEWAY_RENDERER_CONTENT_SECURITY_POLICY,
    );
  });

  test("a worker script gets no document policy", async () => {
    const { get } = await servedGateway();
    const response = await get("assets/app-12345678.js");
    expect(response.status).toBe(200);
    expect(response.headers["content-security-policy"]).toBeUndefined();
  });

  test("the design frame document is sandboxed instead of carrying the renderer's policy", async () => {
    const { get } = await servedGateway();
    const response = await get(DESIGN_FRAME_DOCUMENT.toUpperCase());
    expect(response.status).toBe(200);
    expect(response.headers["content-security-policy"]).toBe(
      GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY,
    );
  });

  test("the login page has its own policy, on an unauthenticated request too", async () => {
    const { info } = await servedGateway();
    for (const pathname of ["__orkestrator/login", ""]) {
      const response = await requestUrl(`${info.url}${pathname}`, {
        headers: { accept: "text/html" },
      });
      expect(response.body).toContain("Orkestrator Gateway");
      expect(response.headers["content-security-policy"]).toBe(
        GATEWAY_LOGIN_CONTENT_SECURITY_POLICY,
      );
    }
  });
});
