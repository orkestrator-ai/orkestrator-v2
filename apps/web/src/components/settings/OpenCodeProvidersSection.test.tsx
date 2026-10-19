import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  OpenCodeProviderAuthEntry,
  OpenCodeProviderAuthSnapshot,
  OpenCodeProviderLoginProgress,
} from "@orkestrator/protocol/opencode-provider-auth";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let snapshot: OpenCodeProviderAuthSnapshot;
let login: OpenCodeProviderLoginProgress = { state: "idle" };

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "list_opencode_provider_auth":
        return Promise.resolve(snapshot);
      case "get_opencode_provider_login":
        return Promise.resolve(login);
      case "start_opencode_provider_login":
        login = {
          state: "pending",
          operationId: "op-1",
          providerId: String(args.providerId),
          providerLabel: String(args.providerLabel),
        };
        return Promise.resolve(login);
      case "cancel_opencode_provider_login":
        login = { state: "idle" };
        return Promise.resolve(login);
      case "remove_opencode_provider_login":
        snapshot = {
          providers: snapshot.providers.map((provider) =>
            provider.id === args.providerId
              ? { ...provider, connected: false, storedLogin: false }
              : provider,
          ),
        };
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  }),
}));

mock.module("@/lib/native/clipboard", () => ({ writeText: mock(async () => undefined) }));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const { OpenCodeProvidersSection } = await import("./OpenCodeProvidersSection");
const { OpenCodeAuthRecoveryAction } =
  await import("@/components/opencode/OpenCodeAuthRecoveryAction");

function provider(overrides: Partial<OpenCodeProviderAuthEntry>): OpenCodeProviderAuthEntry {
  return {
    id: "opencode-go",
    label: "OpenCode Go",
    connected: true,
    storedLogin: true,
    allowed: true,
    methods: [{ index: 0, type: "api", label: "API key", prompts: [] }],
    ...overrides,
  };
}

const OPENAI = provider({
  id: "openai",
  label: "OpenAI",
  connected: false,
  storedLogin: false,
  allowed: false,
  methods: [
    { index: 0, type: "oauth", label: "ChatGPT Pro/Plus (browser)", prompts: [] },
    { index: 1, type: "oauth", label: "ChatGPT Pro/Plus (headless)", prompts: [] },
    { index: 2, type: "api", label: "Manually enter API Key", prompts: [] },
  ],
});

beforeEach(() => {
  calls.length = 0;
  login = { state: "idle" };
  snapshot = {
    providers: [
      provider({}),
      provider({ id: "lmstudio", label: "LM Studio", storedLogin: false, allowed: false }),
      OPENAI,
    ],
  };
});

afterEach(() => {
  cleanup();
});

async function mount() {
  await act(async () => {
    render(<OpenCodeProvidersSection />);
  });
  await screen.findByRole("listitem", { name: "OpenCode Go" });
}

describe("OpenCodeProvidersSection", () => {
  test("lists signed-in and allowed providers, and finds the rest by search", async () => {
    await mount();
    const go = screen.getByRole("listitem", { name: "OpenCode Go" });
    expect(within(go).getByText("Signed in")).toBeTruthy();
    const lmstudio = screen.getByRole("listitem", { name: "LM Studio" });
    expect(within(lmstudio).getByText("Connected by environment or configuration")).toBeTruthy();
    // A login OpenCode does not hold cannot be signed out of here.
    expect(within(lmstudio).queryByRole("button", { name: "Sign out of LM Studio" }) === null).toBe(
      true,
    );
    expect(screen.queryByRole("listitem", { name: "OpenAI" }) === null).toBe(true);

    fireEvent.change(screen.getByLabelText("Find a provider to sign in to"), {
      target: { value: "open" },
    });
    const matches = screen.getByRole("list", { name: "Matching providers" });
    fireEvent.click(within(matches).getByText("OpenAI"));
    const openai = screen.getByRole("listitem", { name: "OpenAI" });
    expect(within(openai).getByRole("radiogroup", { name: "Sign-in method" })).toBeTruthy();
  });

  test("replaces an API key and re-reads the list", async () => {
    await mount();
    const go = screen.getByRole("listitem", { name: "OpenCode Go" });
    fireEvent.click(within(go).getByRole("button", { name: "Sign in again" }));
    const key = within(go).getByLabelText("OpenCode Go API key");
    fireEvent.change(key, { target: { value: "sk-new" } });
    await act(async () => {
      fireEvent.click(within(go).getByRole("button", { name: "Save key" }));
    });
    expect(calls).toContainEqual({
      command: "set_opencode_provider_api_key",
      args: { providerId: "opencode-go", key: "sk-new" },
    });
    await screen.findByText(/Signed in to OpenCode Go\./);
    expect(calls.filter((call) => call.command === "list_opencode_provider_auth")).toHaveLength(2);
  });

  test("runs a browser sign-in and shows the device code", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Find a provider to sign in to"), {
      target: { value: "openai" },
    });
    fireEvent.click(
      within(screen.getByRole("list", { name: "Matching providers" })).getByText("OpenAI"),
    );
    const openai = screen.getByRole("listitem", { name: "OpenAI" });
    fireEvent.click(within(openai).getByRole("radio", { name: "ChatGPT Pro/Plus (headless)" }));
    await act(async () => {
      fireEvent.click(within(openai).getByRole("button", { name: "Continue in browser" }));
    });
    expect(calls).toContainEqual({
      command: "start_opencode_provider_login",
      args: { providerId: "openai", providerLabel: "OpenAI", method: 1 },
    });

    login = {
      ...login,
      url: "https://auth.openai.com/codex/device",
      instructions: "Enter code: ABCD-EFGH",
      userCode: "ABCD-EFGH",
      needsCode: false,
    };
    await waitFor(() => expect(screen.getByText("ABCD-EFGH")).toBeTruthy(), { timeout: 4_000 });
    expect(screen.getByText("Waiting for you to approve the sign-in…")).toBeTruthy();

    login = { state: "succeeded", operationId: "op-1", providerId: "openai" };
    await screen.findByText(/Signed in to OpenAI\./, {}, { timeout: 4_000 });
  });

  test("signs out only after confirmation", async () => {
    await mount();
    const go = screen.getByRole("listitem", { name: "OpenCode Go" });
    fireEvent.click(within(go).getByRole("button", { name: "Sign out of OpenCode Go" }));
    fireEvent.click(within(go).getByRole("button", { name: "Keep" }));
    expect(calls.some((call) => call.command === "remove_opencode_provider_login")).toBe(false);

    fireEvent.click(within(go).getByRole("button", { name: "Sign out of OpenCode Go" }));
    await act(async () => {
      fireEvent.click(within(go).getByRole("button", { name: "Sign out" }));
    });
    expect(calls).toContainEqual({
      command: "remove_opencode_provider_login",
      args: { providerId: "opencode-go" },
    });
    await screen.findByText("Signed out of OpenCode Go.");
  });
});

describe("OpenCodeAuthRecoveryAction", () => {
  test("reads providers only when asked, then signs the failed provider in", async () => {
    await act(async () => {
      render(<OpenCodeAuthRecoveryAction providerId="opencode-go" />);
    });
    expect(calls.some((call) => call.command === "list_opencode_provider_auth")).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in to opencode-go again" }));
    });
    fireEvent.change(await screen.findByLabelText("OpenCode Go API key"), {
      target: { value: "sk-new" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    });
    expect(
      screen.getByText("Signed in to OpenCode Go. Resend your message to continue."),
    ).toBeTruthy();
  });

  test("tells a container environment to restart before resending", async () => {
    await act(async () => {
      render(<OpenCodeAuthRecoveryAction providerId="opencode-go" containerId="c-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in to opencode-go again" }));
    });
    fireEvent.change(await screen.findByLabelText("OpenCode Go API key"), {
      target: { value: "sk-new" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    });
    expect(screen.getByText(/restart it before resending/)).toBeTruthy();
  });
});
