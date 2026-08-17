import { describe, expect, test } from "bun:test";

import type { RuntimeStatusManifest } from "../../electron/runtime-profile.js";
import { formatAgentTestLogin, mintAgentTestLoginUrl } from "./login.js";

type Status = Pick<RuntimeStatusManifest, "profile" | "flavor" | "status" | "browserUrl" | "authFile">;

const readyStatus: Status = {
  profile: "login-qa",
  flavor: "agent-test",
  status: "ready",
  browserUrl: "http://127.0.0.1:41234/",
  authFile: "/tmp/login-qa/auth.json",
};

function stubGateway(expiresAt: number) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ code: "bootstrap-code-value", expiresAt }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  return { requests, fetchImpl };
}

describe("agent-test login link", () => {
  test("mints a single-use URL and keeps the durable token off it", async () => {
    const expiresAt = Date.now() + 120_000;
    const { requests, fetchImpl } = stubGateway(expiresAt);

    const login = await mintAgentTestLoginUrl({
      status: readyStatus,
      fetchImpl,
      readTokenFile: async () => JSON.stringify({ token: "durable-gateway-token" }),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:41234/__orkestrator/agent-test/bootstrap");
    expect(requests[0]!.init?.method).toBe("POST");
    expect((requests[0]!.init?.headers as Record<string, string>).authorization)
      .toBe("Bearer durable-gateway-token");

    expect(login.loginUrl).toBe(
      "http://127.0.0.1:41234/__orkestrator/agent-test/login?code=bootstrap-code-value",
    );
    expect(login.loginUrl).not.toContain("durable-gateway-token");
    expect(login.expiresAt).toBe(expiresAt);
    expect(login.expiresInSeconds).toBeGreaterThan(60);

    const printed = formatAgentTestLogin(login);
    expect(printed).toContain(login.loginUrl);
    expect(printed).not.toContain("durable-gateway-token");
  });

  test("refuses a profile that is not an isolated agent-test profile", async () => {
    const { requests, fetchImpl } = stubGateway(Date.now() + 120_000);
    await expect(mintAgentTestLoginUrl({
      status: { ...readyStatus, flavor: "production" },
      fetchImpl,
      readTokenFile: async () => JSON.stringify({ token: "durable-gateway-token" }),
    })).rejects.toThrow("not an agent-test profile");
    expect(requests).toHaveLength(0);
  });

  test("reports an unstarted profile instead of minting against a stale manifest", async () => {
    const { requests, fetchImpl } = stubGateway(Date.now() + 120_000);
    await expect(mintAgentTestLoginUrl({
      status: { ...readyStatus, status: "stopped" },
      fetchImpl,
      readTokenFile: async () => JSON.stringify({ token: "durable-gateway-token" }),
    })).rejects.toThrow("bun run dev:test");
    expect(requests).toHaveLength(0);
  });

  test("fails loudly when the gateway refuses to mint", async () => {
    await expect(mintAgentTestLoginUrl({
      status: readyStatus,
      fetchImpl: async () => new Response("nope", { status: 401 }),
      readTokenFile: async () => JSON.stringify({ token: "durable-gateway-token" }),
    })).rejects.toThrow("HTTP 401");
  });
});
