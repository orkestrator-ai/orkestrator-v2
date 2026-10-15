import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { OpenCodeCapabilities } from "./opencode-capabilities.js";

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
      "Connect one of OpenCode Go, anthropic from OpenCode settings.",
    );
  });

  test("needs auth when nothing is connected", async () => {
    const status = await capabilities(providerList([]), ["opencode-go"]).authStatus();

    expect(status.state).toBe("needs-auth");
    expect(status.signIn?.hint).toBe("Connect OpenCode Go from OpenCode settings.");
  });
});
