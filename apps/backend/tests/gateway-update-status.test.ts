import { describe, expect, mock, test } from "bun:test";
import type { InvocationOrigin } from "../src/core/commands-context";
import { requestUrl, startGateway } from "./gateway-test-harness";

const TOKEN = "test-token-123456";
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

describe("the status handshake", () => {
  test("answers ok alone when no status is wired, and refuses anonymous callers", async () => {
    const { info } = await startGateway();
    const status = await requestUrl(`${info.url}__orkestrator/status`, { headers: AUTH });
    expect(status.json()).toEqual({ ok: true });
    const anonymous = await requestUrl(`${info.url}__orkestrator/status`);
    expect(anonymous.status).toBe(401);
  });

  test("carries the version and update summary behind authentication", async () => {
    const payload = {
      ok: true as const,
      appVersion: "2.21.0",
      updateProtocol: 1,
      host: { kind: "supervisor" as const, installKind: "npm-package" as const, canInstall: true },
      updates: { channel: "beta" as const, available: "2.22.0-beta.1", jobPhase: null },
    };
    const { info } = await startGateway({ status: () => payload });
    const status = await requestUrl(`${info.url}__orkestrator/status`, { headers: AUTH });
    expect(status.json()).toEqual(payload);
  });

  test("a failing status provider still reports the backend as reachable", async () => {
    const { info } = await startGateway({
      status: () => {
        throw new Error("update state unreadable");
      },
    });
    const status = await requestUrl(`${info.url}__orkestrator/status`, { headers: AUTH });
    expect(status.status).toBe(200);
    expect(status.json()).toEqual({ ok: true });
  });
});

describe("invocation origin", () => {
  async function originsFor(headers: Record<string, string>) {
    const origins: Array<InvocationOrigin | undefined> = [];
    const invoke = mock(
      async (_command: string, _args: Record<string, unknown>, origin?: InvocationOrigin) => {
        origins.push(origin);
        return null;
      },
    );
    const { info } = await startGateway({
      backend: { invoke },
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
    });
    const body = JSON.stringify({ command: "update_get_status", args: {} });
    await requestUrl(`${info.url}__orkestrator/invoke`, {
      method: "POST",
      headers: { ...AUTH, ...headers },
      body,
    });
    await requestUrl(`${info.browserUrl}__orkestrator/invoke`, {
      method: "POST",
      headers: { ...AUTH, ...headers },
      body,
    });
    return origins;
  }

  test("names the listener, and trusts the Tailscale identity only where Tailscale Serve delivers", async () => {
    const [control, browser] = await originsFor({ "tailscale-user-login": "alice@example.com" });
    expect(control).toMatchObject({ listener: "control", tailscaleUser: null });
    expect(browser).toMatchObject({ listener: "browser", tailscaleUser: "alice@example.com" });
    expect(browser?.remoteAddress).toMatch(/127\.0\.0\.1|::1/);
  });

  test("ignores a malformed identity header", async () => {
    const [, browser] = await originsFor({ "tailscale-user-login": "x".repeat(400) });
    expect(browser?.tailscaleUser).toBeNull();
  });
});
