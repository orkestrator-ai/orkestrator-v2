import { describe, expect, test } from "bun:test";

import { requestUrl, startGateway } from "./gateway-test-harness.js";

describe("remote gateway", () => {
  test("routed command errors preserve bounded machine-readable codes", async () => {
    let code: unknown = "gh-auth";
    const { info } = await startGateway({
      env: {},
      backend: {
        invoke: async () => {
          throw Object.assign(new Error("Sign in with gh on Build box."), { code });
        },
      },
    });
    const invoke = () =>
      requestUrl(`${info.url}__orkestrator/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
        body: JSON.stringify({ command: "open_project_agents_md_pr", args: {} }),
      });
    const failure = await invoke();
    expect(failure.status).toBe(500);
    expect(failure.json()).toEqual({ error: "Sign in with gh on Build box.", code: "gh-auth" });
    for (code of [undefined, "x".repeat(65), "not a code", { nested: true }])
      expect((await invoke()).json()).toEqual({ error: "Sign in with gh on Build box." });
  });

  test("returns client errors for malformed, non-object, oversized, and incomplete settings bodies", async () => {
    const { info } = await startGateway({ env: {} });
    const headers = {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
    };

    const malformed = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const nonObject = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers,
      body: "[]",
    });
    expect(nonObject.status).toBe(400);

    const incomplete = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers,
      body: "{}",
    });
    expect(incomplete.status).toBe(400);

    const oversized = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ token: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.connection).toBe("close");
    expect(oversized.json()).toEqual({ error: "Request body is too large" });

    const wrongMethod = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "POST",
      headers,
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("GET, PUT");
  });
});
