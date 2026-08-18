import { describe, expect, test } from "bun:test";

import type { RuntimeProfile, RuntimeStatusManifest } from "../../electron/runtime-profile.js";
import type { DevArguments } from "./arguments.js";
import { loginProfile } from "./lifecycle.js";
import { formatAgentTestLogin, mintAgentTestLoginUrl } from "./login.js";

type Status = Pick<
  RuntimeStatusManifest,
  "profile" | "flavor" | "status" | "browserUrl" | "authFile"
>;

const readyStatus: Status = {
  profile: "login-qa",
  flavor: "agent-test",
  status: "ready",
  browserUrl: "http://127.0.0.1:41234/",
  authFile: "/tmp/login-qa/auth.json",
};

const cliArgs: DevArguments = {
  profile: "login-qa",
  fixture: false,
  fixtureEnvironments: [],
  json: false,
  keepToolchains: false,
  stopFirst: false,
  agentCredentialsDisabled: false,
  credentialSources: [],
  agentPlatforms: [],
};

const fakeProfile: RuntimeProfile = {
  version: 1,
  flavor: "agent-test",
  id: "login-qa",
  displayName: "login-qa",
  repositoryRoot: "/tmp/repo",
  profileRoot: "/tmp/login-qa",
  dataDir: "/tmp/login-qa/data",
  runtimeDir: "/tmp/login-qa/runtime",
  worktreeDir: "/tmp/login-qa/worktrees",
  logDir: "/tmp/login-qa/logs",
  fixtureDir: "/tmp/login-qa/fixtures",
  dockerOwner: "login-qa",
  dockerImage: "orkestrator-v2:dev-test",
  rendererHost: "127.0.0.1",
  rendererPort: 1,
  gatewayHost: "127.0.0.1",
  gatewayPort: 2,
  electronTitle: "login-qa",
  credentialSources: [],
  agentPlatforms: [],
};

const liveStatus: RuntimeStatusManifest = {
  version: 1,
  status: "ready",
  profile: "login-qa",
  flavor: "agent-test",
  dataDir: fakeProfile.dataDir,
  electronTitle: fakeProfile.electronTitle,
  rendererUrl: "http://127.0.0.1:1/",
  browserUrl: readyStatus.browserUrl,
  authFile: readyStatus.authFile,
  logDir: fakeProfile.logDir,
  statusPath: "/tmp/login-qa/runtime/status.json",
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  pids: { launcher: 1 },
  processStartTimes: { launcher: 1 },
};

function stubGateway(
  expiresAt: number,
  body: unknown = { code: "bootstrap-code-value", expiresAt },
) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(body), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  return { requests, fetchImpl };
}

function mint(status: Status, fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return mintAgentTestLoginUrl({
    status,
    fetchImpl,
    readTokenFile: async () => JSON.stringify({ token: "durable-gateway-token" }),
  });
}

describe("agent-test login link", () => {
  test("mints a single-use URL and keeps the durable token off it", async () => {
    const expiresAt = Date.now() + 120_000;
    const { requests, fetchImpl } = stubGateway(expiresAt);

    const login = await mint(readyStatus, fetchImpl);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:41234/__orkestrator/agent-test/bootstrap");
    expect(requests[0]!.init?.method).toBe("POST");
    expect(requests[0]!.init?.redirect).toBe("error");
    expect((requests[0]!.init!.headers as Record<string, string>).authorization).toBe(
      "Bearer durable-gateway-token",
    );

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

  test("accepts IPv6 loopback browser URLs", async () => {
    const { requests, fetchImpl } = stubGateway(Date.now() + 120_000);
    const login = await mint({ ...readyStatus, browserUrl: "http://[::1]:41234/" }, fetchImpl);
    expect(requests).toHaveLength(1);
    expect(login.loginUrl).toBe(
      "http://[::1]:41234/__orkestrator/agent-test/login?code=bootstrap-code-value",
    );
  });

  test("refuses a profile that is not an isolated agent-test profile", async () => {
    const { requests, fetchImpl } = stubGateway(Date.now() + 120_000);
    await expect(mint({ ...readyStatus, flavor: "production" }, fetchImpl)).rejects.toThrow(
      "not an agent-test profile",
    );
    expect(requests).toHaveLength(0);
  });

  test("reports an unstarted profile instead of minting against a stale manifest", async () => {
    const { requests, fetchImpl } = stubGateway(Date.now() + 120_000);
    await expect(mint({ ...readyStatus, status: "stopped" }, fetchImpl)).rejects.toThrow(
      "bun run dev:test",
    );
    expect(requests).toHaveLength(0);
  });

  test("refuses to send the durable token to a non-loopback browser URL", async () => {
    const { requests, fetchImpl } = stubGateway(Date.now() + 120_000);
    const readTokenFile = async () => {
      throw new Error("auth file must not be read for a non-loopback URL");
    };
    for (const browserUrl of [
      "http://example.com/",
      "http://10.0.0.1:41234/",
      "http://127.0.0.1:41234@evil.example/",
    ]) {
      await expect(
        mintAgentTestLoginUrl({
          status: { ...readyStatus, browserUrl },
          fetchImpl,
          readTokenFile,
        }),
      ).rejects.toThrow("not loopback");
    }
    expect(requests).toHaveLength(0);
  });

  test("refuses userinfo even when the parsed hostname is loopback", async () => {
    const { requests, fetchImpl } = stubGateway(Date.now() + 120_000);
    let authFileRead = false;
    for (const browserUrl of [
      "http://name@127.0.0.1:41234/",
      "http://name:password@localhost:41234/",
      "http://name:password@[::1]:41234/",
    ]) {
      await expect(
        mintAgentTestLoginUrl({
          status: { ...readyStatus, browserUrl },
          fetchImpl,
          readTokenFile: async () => {
            authFileRead = true;
            return JSON.stringify({ token: "durable-gateway-token" });
          },
        }),
      ).rejects.toThrow("not loopback");
    }
    expect(authFileRead).toBe(false);
    expect(requests).toHaveLength(0);
  });

  test("refuses a missing browser URL before reading the auth file", async () => {
    const { requests, fetchImpl } = stubGateway(Date.now() + 120_000);
    await expect(mint({ ...readyStatus, browserUrl: undefined }, fetchImpl)).rejects.toThrow(
      "has no browser gateway URL",
    );
    expect(requests).toHaveLength(0);
  });

  test("fails loudly when the auth file is missing, empty, or not JSON", async () => {
    const { requests, fetchImpl } = stubGateway(Date.now() + 120_000);
    await expect(
      mintAgentTestLoginUrl({
        status: { ...readyStatus, authFile: undefined },
        fetchImpl,
        readTokenFile: async () => JSON.stringify({ token: "durable-gateway-token" }),
      }),
    ).rejects.toThrow("has no gateway auth file");

    for (const contents of ["not-json", JSON.stringify({}), JSON.stringify({ token: "" })]) {
      await expect(
        mintAgentTestLoginUrl({
          status: readyStatus,
          fetchImpl,
          readTokenFile: async () => contents,
        }),
      ).rejects.toThrow("Gateway auth file is invalid");
    }
    expect(requests).toHaveLength(0);
  });

  test("fails loudly when the gateway refuses to mint", async () => {
    await expect(
      mint(readyStatus, async () => new Response("nope", { status: 401 })),
    ).rejects.toThrow("HTTP 401");
  });

  test("rejects a malformed bootstrap payload", async () => {
    for (const body of [
      { expiresAt: Date.now() + 120_000 },
      { code: "", expiresAt: Date.now() + 120_000 },
      { code: "bootstrap-code-value" },
      { code: "bootstrap-code-value", expiresAt: Number.NaN },
    ]) {
      const { fetchImpl } = stubGateway(Date.now() + 120_000, body);
      await expect(mint(readyStatus, fetchImpl)).rejects.toThrow("unexpected bootstrap response");
    }
  });

  test("times out when the gateway never returns response headers", async () => {
    await expect(
      mintAgentTestLoginUrl({
        status: readyStatus,
        timeoutMs: 20,
        readTokenFile: async () => JSON.stringify({ token: "durable-gateway-token" }),
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          }),
      }),
    ).rejects.toThrow("Timed out minting a login link for profile login-qa");
  });

  test("times out when the gateway stalls the bootstrap response body", async () => {
    const body = new ReadableStream<Uint8Array>({ start: () => undefined });
    await expect(
      mintAgentTestLoginUrl({
        status: readyStatus,
        timeoutMs: 20,
        readTokenFile: async () => JSON.stringify({ token: "durable-gateway-token" }),
        fetchImpl: async () =>
          new Response(body, {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("Timed out minting a login link for profile login-qa");
  });
});

describe("dev:login profile command", () => {
  test("refuses a profile with no runtime status instead of minting", async () => {
    let minted = false;
    await expect(
      loginProfile(cliArgs, {
        resolveProfile: async () => fakeProfile,
        readStatus: async () => null,
        mint: async () => {
          minted = true;
          throw new Error("mint must not run");
        },
      }),
    ).rejects.toThrow("has no runtime status");
    expect(minted).toBe(false);
  });

  test("refuses a profile whose launcher is not live", async () => {
    let minted = false;
    await expect(
      loginProfile(cliArgs, {
        resolveProfile: async () => fakeProfile,
        readStatus: async () => liveStatus,
        liveness: () => ({ launcher: false }),
        mint: async () => {
          minted = true;
          throw new Error("mint must not run");
        },
      }),
    ).rejects.toThrow("is not running");
    expect(minted).toBe(false);
  });

  test("prints a minted login URL without the durable token", async () => {
    const lines: string[] = [];
    const login = {
      profile: "login-qa",
      browserUrl: "http://127.0.0.1:41234/",
      loginUrl: "http://127.0.0.1:41234/__orkestrator/agent-test/login?code=bootstrap-code-value",
      expiresAt: Date.now() + 120_000,
      expiresInSeconds: 120,
    };
    const status = await loginProfile(cliArgs, {
      resolveProfile: async () => fakeProfile,
      readStatus: async () => liveStatus,
      liveness: () => ({ launcher: true }),
      mint: async () => login,
      log: (line) => lines.push(line),
    });
    expect(status).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(login.loginUrl);
    expect(lines[0]).not.toContain("durable-gateway-token");
  });

  test("prints machine-readable JSON under --json", async () => {
    // The browser suite parses this stdout, so the shape is a contract: one JSON
    // document on its own, with no human preamble to trip JSON.parse.
    const lines: string[] = [];
    const login = {
      profile: "login-qa",
      browserUrl: "http://127.0.0.1:41234/",
      loginUrl: "http://127.0.0.1:41234/__orkestrator/agent-test/login?code=bootstrap-code-value",
      expiresAt: Date.now() + 120_000,
      expiresInSeconds: 120,
    };
    const status = await loginProfile(
      { ...cliArgs, json: true },
      {
        resolveProfile: async () => fakeProfile,
        readStatus: async () => liveStatus,
        liveness: () => ({ launcher: true }),
        mint: async () => login,
        log: (line) => lines.push(line),
      },
    );

    expect(status).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(login);
    expect(lines[0]).not.toContain("durable-gateway-token");
  });
});
