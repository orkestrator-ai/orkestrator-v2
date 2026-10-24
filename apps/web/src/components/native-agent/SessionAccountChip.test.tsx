import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  AgentAccountsSnapshot,
  AgentAccountSummary,
  AgentSessionAccount,
} from "@orkestrator/protocol/agent-accounts";

const calls: string[] = [];
let snapshot: AgentAccountsSnapshot;
let session: AgentSessionAccount | null;

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string) => {
    calls.push(command);
    if (command === "list_agent_accounts") return Promise.resolve(snapshot);
    if (command === "get_native_agent_session_account") return Promise.resolve(session);
    return Promise.resolve(undefined);
  }),
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const { SessionAccountChip, shortAccountLabel } = await import("./SessionAccountChip");
const { onAgentInformationRequest } = await import("@/lib/agent-information");

const WORK = "11111111-2222-4333-8444-555555555555";

function account(overrides: Partial<AgentAccountSummary>): AgentAccountSummary {
  return {
    id: "default",
    platform: "claude",
    label: "Host login",
    isDefault: true,
    isActive: true,
    signedIn: true,
    identity: {},
    ...overrides,
  };
}

const HOST = account({ identity: { email: "me@example.com" } });
const WORK_ACCOUNT = account({
  id: WORK,
  label: "Work",
  isDefault: false,
  isActive: false,
  identity: { email: "work@example.com" },
});

async function mount(platform = "claude") {
  await act(async () => {
    render(<SessionAccountChip environmentId="env-1" platform={platform} />);
  });
}

beforeEach(() => {
  calls.length = 0;
  snapshot = { accounts: [HOST], active: { claude: "default", codex: "default" } };
  session = { platform: "claude", source: "account", account: HOST, running: true };
});

afterEach(() => {
  cleanup();
});

describe("SessionAccountChip", () => {
  test("shows nothing, and reads no session, while the machine has one login", async () => {
    await mount();
    expect(screen.queryByTestId("session-account-chip") === null).toBe(true);
    expect(calls).toEqual(["list_agent_accounts"]);
  });

  test("names the session's account once the machine has more than one", async () => {
    snapshot = { ...snapshot, accounts: [HOST, WORK_ACCOUNT] };
    await mount();
    const chip = await screen.findByTestId("session-account-chip");
    expect(chip.textContent).toBe("me@…");
    expect(chip.className).not.toContain("amber");
  });

  test("is highlighted while the session is not on the active account, and opens the panel", async () => {
    snapshot = { accounts: [HOST, WORK_ACCOUNT], active: { claude: WORK, codex: "default" } };
    session = { ...session!, pendingActive: WORK_ACCOUNT };
    await mount();
    const chip = await screen.findByTestId("session-account-chip");
    expect(chip.className).toContain("amber");
    expect(chip.getAttribute("title")).toContain("moves to Work (work@example.com)");
    let opened = 0;
    const stop = onAgentInformationRequest(() => {
      opened += 1;
    });
    try {
      fireEvent.click(chip);
    } finally {
      stop();
    }
    expect(opened).toBe(1);
  });

  test("is not offered for platforms without accounts", async () => {
    await mount("grok");
    expect(calls).toEqual([]);
  });

  test("shortens an email to its name, and a long label", () => {
    expect(shortAccountLabel(WORK_ACCOUNT)).toBe("work@…");
    expect(shortAccountLabel(account({ label: "A very long account label here" }))).toBe(
      "A very long accou…",
    );
  });
});
