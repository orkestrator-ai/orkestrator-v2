import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { OpenCodeCapabilities } from "./opencode-capabilities.js";
import {
  AUTH_SECRET_CANARIES,
  captureOutput,
  expectAuthStatusShape,
  expectNoCanary,
  expectNothingSecretLogged,
} from "../../../../tests/helpers/auth-secret-canaries.js";

function capabilities(data: unknown, allowedProviders: readonly string[]) {
  const client = {
    provider: { list: async () => ({ data }) },
  } as unknown as OpencodeClient;
  return new OpenCodeCapabilities(
    client,
    "/workspace",
    () => ({ signal: new AbortController().signal }),
    async () => allowedProviders,
  );
}

/** OpenCode's `all` lists every provider it knows about, well past 128. */
function providerList(connected: string[]) {
  const all = Array.from({ length: 200 }, (_, index) => ({
    id: `provider-${index}`,
    name: `Provider ${index}`,
  }));
  all.push({ id: "opencode-go", name: "OpenCode Go" });
  return { all, connected, default: {} };
}

describe("OpenCodeCapabilities.authStatus", () => {
  test("is signed in when the connected provider is listed past the cap", async () => {
    const status = await capabilities(providerList(["opencode-go"]), ["opencode-go"]).authStatus();

    expect(status.state).toBe("signed-in");
    expect(status.providers).toHaveLength(128);
    expect(status.providers?.[0]).toEqual({
      id: "opencode-go",
      label: "OpenCode Go",
      state: "signed-in",
    });
  });

  test("reports provider names only, never the keys OpenCode lists with them", async () => {
    // `provider.list` returns each provider's resolved options and key.
    const data = {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          key: AUTH_SECRET_CANARIES.anthropicApiKey,
          env: ["ANTHROPIC_API_KEY"],
          options: { apiKey: AUTH_SECRET_CANARIES.anthropicApiKey },
        },
        {
          id: "openai",
          name: "OpenAI",
          options: {
            apiKey: AUTH_SECRET_CANARIES.openAiApiKey,
            headers: { authorization: `Bearer ${AUTH_SECRET_CANARIES.accessToken}` },
          },
        },
      ],
      connected: ["anthropic", { id: "openai", key: AUTH_SECRET_CANARIES.openAiApiKey }],
      default: {},
    };
    const { result: status, output } = await captureOutput(() =>
      capabilities(data, []).authStatus(),
    );

    expectAuthStatusShape(status);
    expect(status.state).toBe("signed-in");
    expectNoCanary(status, "OpenCode auth status");
    expectNothingSecretLogged(output, "OpenCode auth status");
  });

  test("is signed in with an unrestricted allowlist", async () => {
    const status = await capabilities(providerList(["opencode-go"]), []).authStatus();

    expect(status.state).toBe("signed-in");
    expect(status.providers?.[0]?.id).toBe("opencode-go");
  });

  test("needs auth when only providers outside the allowlist are connected", async () => {
    const status = await capabilities(providerList(["provider-150"]), [
      "opencode-go",
      "anthropic",
    ]).authStatus();

    expect(status.state).toBe("needs-auth");
    // The connected provider still survives the cap, ahead of the allowlisted one.
    expect(status.providers?.slice(0, 2).map((provider) => provider.id)).toEqual([
      "provider-150",
      "opencode-go",
    ]);
    expect(status.signIn?.hint).toBe(
      "Sign one of OpenCode Go, anthropic in from Settings → OpenCode.",
    );
  });

  test("needs auth when nothing is connected", async () => {
    const status = await capabilities(providerList([]), ["opencode-go"]).authStatus();

    expect(status.state).toBe("needs-auth");
    expect(status.signIn?.hint).toBe("Sign OpenCode Go in from Settings → OpenCode.");
  });

  test("accepts object-shaped connected entries alongside strings and invalid entries", async () => {
    const status = await capabilities(
      {
        ...providerList([]),
        connected: [null, "", { id: " " }, {}, { id: " opencode-go " }, "provider-150"],
      },
      ["opencode-go"],
    ).authStatus();

    expect(status.state).toBe("signed-in");
    expect(status.providers?.slice(0, 2)).toEqual([
      { id: "opencode-go", label: "OpenCode Go", state: "signed-in" },
      { id: "provider-150", label: "Provider 150", state: "signed-in" },
    ]);
  });

  test("ignores null and empty connected IDs with an unrestricted allowlist", async () => {
    const status = await capabilities(
      {
        ...providerList([]),
        connected: [null, "", " ", {}, { id: null }, { id: "" }, { id: " " }],
      },
      [],
    ).authStatus();

    expect(status.state).toBe("needs-auth");
    expect(status.providers?.every((provider) => provider.state === "signed-out")).toBe(true);
  });

  test.each([
    { name: "unrestricted", allowed: [] },
    {
      name: "more than eight providers",
      allowed: Array.from({ length: 9 }, (_, i) => `provider-${i}`),
    },
  ])("uses the generic sign-in hint for $name", async ({ allowed }) => {
    const status = await capabilities(providerList([]), allowed).authStatus();

    expect(status.state).toBe("needs-auth");
    expect(status.signIn?.hint).toBe("Sign a provider in from Settings → OpenCode.");
  });

  test("names all eight providers at the hint limit", async () => {
    const allowed = Array.from({ length: 8 }, (_, i) => `provider-${i}`);
    const status = await capabilities(providerList([]), allowed).authStatus();

    expect(status.signIn?.hint).toBe(
      "Sign one of Provider 0, Provider 1, Provider 2, Provider 3, Provider 4, Provider 5, Provider 6, Provider 7 in from Settings → OpenCode.",
    );
  });

  test("matches mixed-case provider IDs to the lowercased allowlist and hint labels", async () => {
    const status = await capabilities(
      {
        all: [{ id: "OpenCode-Go", name: "OpenCode Go" }],
        connected: ["OpenCode-Go"],
      },
      ["opencode-go"],
    ).authStatus();

    expect(status.state).toBe("signed-in");
    expect(status.providers).toEqual([
      { id: "OpenCode-Go", label: "OpenCode Go", state: "signed-in" },
    ]);
    expect(status.signIn?.hint).toBe("Sign OpenCode Go in from Settings → OpenCode.");
  });

  test("is signed in when the connected selectable provider is absent from all", async () => {
    const status = await capabilities({ all: [], connected: ["opencode-go"] }, [
      "opencode-go",
    ]).authStatus();

    expect(status.state).toBe("signed-in");
    expect(status.providers).toEqual([]);
    expect(status.signIn?.hint).toBe("Sign opencode-go in from Settings → OpenCode.");
  });
});

describe("OpenCodeCapabilities.mcpServers", () => {
  test("redacts credential-shaped error text before bounding it", async () => {
    const client = {
      mcp: {
        status: async () => ({
          data: {
            docs: {
              status: "failed",
              error: `401 from https://user:hunter2hunter2@mcp.example.test/?api_key=sk-abcdefghijklmnopqrstuvwx Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 ${"x".repeat(3_000)}`,
            },
          },
        }),
      },
    } as unknown as OpencodeClient;
    const servers = await new OpenCodeCapabilities(
      client,
      "/workspace",
      () => ({ signal: new AbortController().signal }),
      async () => [],
    ).mcpServers();
    const error = servers[0]?.error ?? "";
    expect(error).toContain("401 from");
    expect(error).not.toContain("hunter2hunter2");
    expect(error).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(error).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(error.length).toBeLessThanOrEqual(2_000);
  });
});

describe("OpenCode MCP sign-in", () => {
  function withStatus(status: Record<string, unknown>, calls: string[] = []) {
    const client = {
      mcp: {
        status: async () => ({ data: status }),
        auth: {
          start: async () => {
            calls.push("start");
            return { data: { authorizationUrl: "https://auth.example.test/authorize" } };
          },
        },
      },
    } as unknown as OpencodeClient;
    return new OpenCodeCapabilities(
      client,
      "/workspace",
      () => ({ signal: new AbortController().signal }),
      async () => [],
    );
  }

  test("a server that needs auth gets the terminal route, not an in-app sign-in", async () => {
    const [server] = await withStatus({ docs: { status: "needs_auth" } }).mcpServers();
    expect(server).toMatchObject({ status: "needs-auth", actions: ["reconnect"] });
    expect(server?.hint).toContain("opencode mcp auth docs");
  });

  test("a stale sign-in request is refused with the route, and starts nothing", async () => {
    const calls: string[] = [];
    await expect(withStatus({}, calls).mcpServerAction("docs", "sign-in")).rejects.toThrow(
      "opencode mcp auth docs",
    );
    // `mcp.auth.start` alone leaves OpenCode with no callback waiter.
    expect(calls).toEqual([]);
  });
});
