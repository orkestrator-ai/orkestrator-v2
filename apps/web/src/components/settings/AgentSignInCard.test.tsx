import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentAuthState,
  NativeAgentAuthStatus,
} from "@orkestrator/protocol/native-agent";
import { AccountMachineProvider } from "./account-machine";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let statuses: Partial<Record<AgentPlatform, NativeAgentAuthStatus>> = {};
let failRead = false;
/** The command node's answer to `invoke_on_node` (another machine), when a test sets one. */
let routed: ((command: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string, args: Record<string, unknown> = {}) => {
    // The window's command scope routes another machine's commands; they are not local calls.
    if (command === "invoke_on_node" && routed) return routed(command, args);
    calls.push({ command, args });
    switch (command) {
      case "get_agent_sign_in_status":
        return failRead
          ? Promise.reject(new Error("Could not read the sign-in state"))
          : Promise.resolve(statuses[args.platform as AgentPlatform]);
      case "get_agent_account_login":
        return Promise.resolve({ state: "idle" });
      case "start_agent_account_login":
        return Promise.resolve({
          state: "pending",
          operationId: "reauth-1",
          accountId: "default",
          platform: "claude",
          mode: "reauthenticate",
          url: "https://claude.example.test/authorize",
          needsCode: true,
        });
      default:
        return Promise.resolve(undefined);
    }
  }),
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const { AgentSignInCard } = await import("./AgentSignInCard");

const STATE_LABELS: Record<NativeAgentAuthState, string> = {
  "signed-in": "Signed in",
  "signed-out": "Signed out",
  "needs-auth": "Needs sign-in",
  expired: "Login expired",
  unknown: "Not confirmed",
};

const HINTS: Record<AgentPlatform, string> = {
  claude: "Sign the active Claude account in again from this card.",
  codex: "Sign in from a Codex tab, or add an account below and make it active.",
  cursor: "",
  grok: "Open a terminal and run grok login.",
  opencode: "Sign each model provider in under Provider Sign-in.",
  pi: "Open a Pi terminal tab and run /login.",
};

function fixture(platform: AgentPlatform, state: NativeAgentAuthState): NativeAgentAuthStatus {
  return {
    state,
    ...(state === "signed-in"
      ? { account: { label: `${platform}@example.test`, plan: "pro" } }
      : {}),
    signIn: {
      kind: platform === "cursor" ? "browser-url" : "terminal",
      ...(HINTS[platform] ? { hint: HINTS[platform] } : {}),
    },
    signOut: false,
  };
}

beforeEach(() => {
  routed = null;
  calls.length = 0;
  statuses = {};
  failRead = false;
});

afterEach(() => {
  routed = null;
  cleanup();
  resetReadCoordinatorForTests();
});

describe("AgentSignInCard", () => {
  const states = Object.keys(STATE_LABELS) as NativeAgentAuthState[];
  test.each(
    AGENT_PLATFORMS.flatMap((platform) => states.map((state) => [platform, state] as const)),
  )("%s shows the %s fixture without a session", async (platform, state) => {
    statuses[platform] = fixture(platform, state);
    renderInAppCommandScope(<AgentSignInCard platform={platform} />);
    const card = screen.getByRole("region", { name: new RegExp(`sign-in$`) });
    expect(await within(card).findByText(STATE_LABELS[state])).toBeTruthy();
    expect(calls).toContainEqual({ command: "get_agent_sign_in_status", args: { platform } });
    if (state === "signed-in") {
      expect(within(card).getByText(`${platform}@example.test · pro`)).toBeTruthy();
      // Nothing to do: no hint, no sign-in action.
      if (HINTS[platform])
        expect(within(card).queryByText(HINTS[platform], { exact: false }) === null).toBe(true);
      expect(within(card).queryByRole("button", { name: "Sign in to Claude" }) === null).toBe(true);
    } else {
      if (HINTS[platform])
        expect(within(card).getByText(HINTS[platform], { exact: false })).toBeTruthy();
      expect(within(card).queryByRole("button", { name: "Sign in to Claude" }) !== null).toBe(
        platform === "claude",
      );
    }
  });

  test("Claude signs the active account in again from the card", async () => {
    statuses.claude = fixture("claude", "signed-out");
    renderInAppCommandScope(<AgentSignInCard platform="claude" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Claude" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        command: "start_agent_account_login",
        args: { platform: "claude", reauthenticate: true },
      }),
    );
  });

  test("status and Claude reauthentication use the selected machine", async () => {
    statuses.claude = fixture("claude", "signed-out");
    const portal = mock(async (command: string, args: Record<string, unknown> = {}) => {
      expect(command).toBe("invoke_on_node");
      expect(args.nodeId).toBe("leaf");
      const result =
        args.command === "get_agent_sign_in_status"
          ? statuses.claude
          : args.command === "start_agent_account_login"
            ? {
                state: "pending",
                operationId: "remote-reauth",
                platform: "claude",
                mode: "reauthenticate",
              }
            : { state: "idle" };
      return { outcome: "ok", result };
    });
    routed = portal;
    renderInAppCommandScope(
      <AccountMachineProvider value={{ machine: "leaf", name: "Leaf" }}>
        <AgentSignInCard platform="claude" />
      </AccountMachineProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Claude" }));
    await waitFor(() =>
      expect(
        portal.mock.calls.some(
          ([, args]) =>
            args?.command === "start_agent_account_login" &&
            (args.args as Record<string, unknown> | undefined)?.reauthenticate === true,
        ),
      ).toBe(true),
    );
    expect(calls).toEqual([]);
  });

  test("shows no login end when the account reports none", async () => {
    statuses.cursor = fixture("cursor", "signed-in");
    const { container } = renderInAppCommandScope(<AgentSignInCard platform="cursor" />);
    expect(await screen.findByText("cursor@example.test · pro")).toBeTruthy();
    expect(container.querySelector("[data-sign-in-expiry]") === null).toBe(true);
  });

  test.each([
    [{ expiresAt: "2099-12-03T10:00:00.000Z" }, "upcoming", /^Sign-in ends (?!about)/],
    [
      { expiresAt: "2099-12-03T10:00:00.000Z", expiresAtEstimated: true as const },
      "upcoming",
      /^Sign-in ends about /,
    ],
    [{ expiresAt: "2001-01-01T00:00:00.000Z" }, "ended", /^Sign-in may have ended on /],
  ])("shows the account's login end %o under its label", async (expiry, tone, text) => {
    const signedIn = fixture("cursor", "signed-in");
    statuses.cursor = { ...signedIn, account: { ...signedIn.account!, ...expiry } };
    const { container } = renderInAppCommandScope(<AgentSignInCard platform="cursor" />);
    expect(await screen.findByText("cursor@example.test · pro")).toBeTruthy();
    const line = container.querySelector("[data-sign-in-expiry]");
    expect(line?.getAttribute("data-sign-in-expiry")).toBe(tone);
    expect(line?.textContent).toMatch(text);
  });

  test("names the terminal command for Grok and Pi", async () => {
    statuses.grok = fixture("grok", "signed-out");
    renderInAppCommandScope(<AgentSignInCard platform="grok" />);
    expect(await screen.findByText("grok login")).toBeTruthy();
  });

  test("lists signed-in providers for provider-based platforms", async () => {
    statuses.opencode = {
      state: "signed-in",
      providers: [
        { id: "anthropic", label: "anthropic", state: "signed-in", method: "oauth" },
        { id: "openai", label: "openai", state: "signed-in", method: "api-key" },
      ],
      signIn: { kind: "terminal", hint: HINTS.opencode },
      signOut: false,
    };
    renderInAppCommandScope(<AgentSignInCard platform="opencode" />);
    const list = await screen.findByRole("list", { name: "OpenCode signed-in providers" });
    expect(within(list).getByText("anthropic · oauth")).toBeTruthy();
    expect(within(list).getByText("openai · api-key")).toBeTruthy();
  });

  test("wraps the platform's own sign-in controls and re-reads on demand", async () => {
    statuses.cursor = fixture("cursor", "signed-out");
    renderInAppCommandScope(
      <AgentSignInCard platform="cursor">
        <button type="button">Sign in with Cursor</button>
      </AgentSignInCard>,
    );
    expect(await screen.findByText("Signed out")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with Cursor" })).toBeTruthy();

    statuses.cursor = fixture("cursor", "signed-in");
    fireEvent.click(screen.getByRole("button", { name: "Refresh Cursor Agent sign-in" }));
    expect(await screen.findByText("Signed in")).toBeTruthy();
  });

  test("shows a failed read instead of a state", async () => {
    failRead = true;
    renderInAppCommandScope(<AgentSignInCard platform="codex" />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not read the sign-in state",
    );
  });
});
