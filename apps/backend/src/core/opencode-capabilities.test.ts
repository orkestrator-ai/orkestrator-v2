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
      "Connect one of OpenCode Go, anthropic with opencode auth login in a terminal.",
    );
  });

  test("needs auth when nothing is connected", async () => {
    const status = await capabilities(providerList([]), ["opencode-go"]).authStatus();

    expect(status.state).toBe("needs-auth");
    expect(status.signIn?.hint).toBe("Connect OpenCode Go with opencode auth login in a terminal.");
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
    expect(status.signIn?.hint).toBe("Connect a provider with opencode auth login in a terminal.");
  });

  test("names all eight providers at the hint limit", async () => {
    const allowed = Array.from({ length: 8 }, (_, i) => `provider-${i}`);
    const status = await capabilities(providerList([]), allowed).authStatus();

    expect(status.signIn?.hint).toBe(
      "Connect one of Provider 0, Provider 1, Provider 2, Provider 3, Provider 4, Provider 5, Provider 6, Provider 7 with opencode auth login in a terminal.",
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
    expect(status.signIn?.hint).toBe("Connect OpenCode Go with opencode auth login in a terminal.");
  });

  test("is signed in when the connected selectable provider is absent from all", async () => {
    const status = await capabilities({ all: [], connected: ["opencode-go"] }, [
      "opencode-go",
    ]).authStatus();

    expect(status.state).toBe("signed-in");
    expect(status.providers).toEqual([]);
    expect(status.signIn?.hint).toBe("Connect opencode-go with opencode auth login in a terminal.");
  });
});
