import { describe, expect, test } from "bun:test";

import type { CommandContext } from "./commands-context.js";
import { containerSignInGuidance } from "./container-sign-in-guidance.js";
import { createNativeAgentProvider } from "./native-agent-provider.js";
import type { Environment } from "./models.js";

const SIGNED_OUT = "You've been signed out of Codex. Sign in again to keep working.";

function context(
  environment: Partial<Environment> | null,
  options: { activeCodex?: string } = {},
): CommandContext {
  return {
    runtimeFlavor: undefined,
    storage: {
      getEnvironment: async () =>
        environment
          ? ({
              id: "env-1",
              environmentType: "containerized",
              containerId: "container-1",
              ...environment,
            } as Environment)
          : undefined,
      loadConfig: async () => ({ global: { enabledAgentPlatforms: ["codex", "grok"] } }),
      loadAgentAccounts: async () => ({
        accounts: [],
        active: options.activeCodex ? { codex: options.activeCodex } : {},
      }),
      agentAccountsDirectory: () => "/accounts",
    },
  } as unknown as CommandContext;
}

describe("containerSignInGuidance", () => {
  test("tells a container that imports the host login to renew it on the host and restart", async () => {
    const codex = await containerSignInGuidance(context({}), "env-1", "codex");
    expect(codex).toContain("Run codex on the host");
    expect(codex).toContain("restart this environment");
    const grok = await containerSignInGuidance(context({}), "env-1", "grok");
    expect(grok).toContain("Run grok on the host");
    const account = await containerSignInGuidance(
      context({}, { activeCodex: "11111111-2222-4333-8444-555555555555" }),
      "env-1",
      "codex",
    );
    expect(account).toContain("active Codex account");
  });

  test("keeps the bridge's message where the login is the container's own", async () => {
    expect(
      await containerSignInGuidance(
        context({ revokedInputProviders: ["codex"] }),
        "env-1",
        "codex",
      ),
    ).toBeUndefined();
    expect(
      await containerSignInGuidance(context({ environmentType: "local" }), "env-1", "codex"),
    ).toBeUndefined();
    expect(await containerSignInGuidance(context(null), "env-1", "codex")).toBeUndefined();
    expect(await containerSignInGuidance(context({}), "env-1", "claude")).toBeUndefined();
  });
});

describe("sign-in guidance on provider snapshots", () => {
  const codexConnection = { agent: "codex" as const, baseUrl: "http://bridge", authToken: "t" };
  const fetchSignedOut = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/config")) return Response.json({ model: "gpt-5.5" });
    if (url.endsWith("/messages")) return Response.json({ messages: [] });
    return Response.json({
      status: "idle",
      messageRevision: 0,
      readiness: {
        state: "authentication-required",
        message: SIGNED_OUT,
        signIn: { kind: "browser-url" },
      },
    });
  }) as typeof fetch;

  test("replaces a confirmed sign-out's message and keeps the sign-in route", async () => {
    const asked: string[] = [];
    const provider = createNativeAgentProvider(codexConnection, {
      fetch: fetchSignedOut,
      environment: {
        environmentId: "env-1",
        signInGuidance: async (agent) => {
          asked.push(agent);
          return "Renew it on the host, then restart.";
        },
      },
    });
    expect((await provider.sessionStateSnapshot!("session-1")).readiness).toEqual({
      state: "authentication-required",
      message: "Renew it on the host, then restart.",
      signIn: { kind: "browser-url" },
    });
    expect((await provider.interactiveSnapshot!("session-1")).readiness).toMatchObject({
      message: "Renew it on the host, then restart.",
    });
    expect(asked).toEqual(["codex", "codex"]);
  });

  test("keeps the bridge's message without guidance, and asks nothing while signed in", async () => {
    let asked = 0;
    const provider = createNativeAgentProvider(codexConnection, {
      fetch: fetchSignedOut,
      environment: { environmentId: "env-1", signInGuidance: async () => undefined },
    });
    expect((await provider.sessionStateSnapshot!("session-1")).readiness).toMatchObject({
      message: SIGNED_OUT,
    });
    const signedIn = createNativeAgentProvider(codexConnection, {
      fetch: (async (input: RequestInfo | URL) =>
        String(input).endsWith("/config")
          ? Response.json({ model: "gpt-5.5" })
          : Response.json({ status: "idle" })) as typeof fetch,
      environment: {
        environmentId: "env-1",
        signInGuidance: async () => {
          asked++;
          return "never";
        },
      },
    });
    expect((await signedIn.sessionStateSnapshot!("session-1")).readiness).toBeUndefined();
    expect(asked).toBe(0);
  });
});
