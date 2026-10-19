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
let listError: Error | undefined;
let removeError: Error | undefined;

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    switch (command) {
      case "list_opencode_provider_auth":
        return listError ? Promise.reject(listError) : Promise.resolve(snapshot);
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
      case "submit_opencode_provider_login_code":
        login = { ...login, codeSubmitted: true };
        return Promise.resolve(login);
      case "remove_opencode_provider_login":
        if (removeError) return Promise.reject(removeError);
        snapshot = {
          providers: snapshot.providers.map((provider) =>
            provider.id === args.providerId
              ? {
                  ...provider,
                  connected: Boolean(provider.canRemoveStoredLogin),
                  storedLogin: false,
                }
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
  listError = undefined;
  removeError = undefined;
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
  delete window.orkestratorGateway;
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

  test("keeps pending OAuth cancellable when collapsed and after remount", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Find a provider to sign in to"), {
      target: { value: "openai" },
    });
    fireEvent.click(
      within(screen.getByRole("list", { name: "Matching providers" })).getByText("OpenAI"),
    );
    const row = screen.getByRole("listitem", { name: "OpenAI" });
    await act(async () =>
      fireEvent.click(within(row).getByRole("button", { name: "Continue in browser" })),
    );
    // Collapse before the section's next poll. Its global observer still owns a cancel path.
    fireEvent.click(within(row).getByRole("button", { name: "Sign in" }));
    await screen.findByRole("button", { name: "Cancel sign-in to OpenAI" }, { timeout: 4000 });
    expect(
      (
        within(screen.getByRole("listitem", { name: "OpenCode Go" })).getByRole("button", {
          name: "Sign in again",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    cleanup();
    await mount();
    expect(screen.getByRole("listitem", { name: "OpenAI" })).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in to OpenAI" })),
    );
    expect(calls).toContainEqual({
      command: "cancel_opencode_provider_login",
      args: { operationId: "op-1" },
    });
  });

  test("remounts after an unobserved completion with a fresh provider snapshot", async () => {
    login = {
      state: "pending",
      providerId: "openai",
      providerLabel: "OpenAI",
      operationId: "op-1",
    };
    await mount();
    cleanup();
    login = { ...login, state: "succeeded" };
    snapshot = { providers: [{ ...OPENAI, connected: true, storedLogin: true }] };
    await act(async () => {
      render(<OpenCodeProvidersSection />);
    });
    expect(
      within(await screen.findByRole("listitem", { name: "OpenAI" })).getByText("Signed in"),
    ).toBeTruthy();
  });

  test("prefers headless OAuth remotely and explains loopback limitations", async () => {
    window.orkestratorGateway = { enabled: true, baseUrl: "https://remote.example.test" };
    snapshot = { providers: [{ ...OPENAI, allowed: true }] };
    await act(async () => {
      render(<OpenCodeProvidersSection />);
    });
    const row = await screen.findByRole("listitem", { name: "OpenAI" });
    fireEvent.click(within(row).getByRole("button", { name: "Sign in" }));
    expect(
      screen
        .getByRole("radio", { name: "ChatGPT Pro/Plus (headless)" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByText(/Browser loopback sign-in must be completed on the backend machine/),
    ).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Continue in browser" })),
    );
    expect(calls).toContainEqual({
      command: "start_opencode_provider_login",
      args: { providerId: "openai", providerLabel: "OpenAI", method: 1 },
    });
  });

  test("adopts submitted code before polling and prevents a second submission", async () => {
    snapshot = { providers: [{ ...OPENAI, allowed: true }] };
    login = {
      state: "pending",
      operationId: "op-code",
      providerId: "openai",
      providerLabel: "OpenAI",
      url: "https://auth.example.test",
      needsCode: true,
    };
    await act(async () => {
      render(<OpenCodeProvidersSection />);
    });
    fireEvent.change(screen.getByLabelText("Sign-in code"), { target: { value: "code-one" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
    fireEvent.change(screen.getByLabelText("Sign-in code"), { target: { value: "code-two" } });
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      calls.filter((call) => call.command === "submit_opencode_provider_login_code"),
    ).toHaveLength(1);
  });

  test("removes a stored login hidden by config and describes the remaining connection", async () => {
    snapshot = { providers: [provider({ canRemoveStoredLogin: true, storedLogin: false })] };
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Remove stored login for OpenCode Go" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Remove stored login" })),
    );
    expect(
      screen.getByText(/Environment or configuration credentials may keep it connected/),
    ).toBeTruthy();
    expect(screen.getByText("Connected by environment or configuration")).toBeTruthy();
    expect(calls).toContainEqual({
      command: "remove_opencode_provider_login",
      args: { providerId: "opencode-go" },
    });
  });

  test("shows initial read failure and keeps a prior snapshot on refresh failure", async () => {
    listError = new Error("Provider list unavailable");
    await act(async () => {
      render(<OpenCodeProvidersSection />);
    });
    expect(await screen.findByText("Provider list unavailable")).toBeTruthy();
    listError = undefined;
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Refresh provider sign-in" })),
    );
    expect(screen.getByRole("listitem", { name: "OpenCode Go" })).toBeTruthy();
    listError = new Error("Refresh failed");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Refresh provider sign-in" })),
    );
    expect(screen.getByText("Refresh failed")).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "OpenCode Go" })).toBeTruthy();
  });

  test("keeps the signed-in snapshot and offers retry after failed sign-out", async () => {
    await mount();
    removeError = new Error("Sign-out failed");
    fireEvent.click(screen.getByRole("button", { name: "Sign out of OpenCode Go" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign out" })));
    expect(screen.getByText("Sign-out failed")).toBeTruthy();
    expect(
      within(screen.getByRole("listitem", { name: "OpenCode Go" })).getByText("Signed in"),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Sign out of OpenCode Go" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
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
