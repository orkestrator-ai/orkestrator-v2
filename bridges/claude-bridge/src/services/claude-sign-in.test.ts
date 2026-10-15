import { describe, expect, mock, spyOn, test } from "bun:test";

import {
  createSession,
  nextQueryCall,
  queryControlOverrides,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";
import {
  CLAUDE_SIGN_IN_REQUIRED_MESSAGE,
  claudeReadiness,
  normalizeClaudeAccount,
  noteClaudeAuthenticationFailure,
  readClaudeAuthStatus,
} from "./claude-sign-in.js";

// What `accountInfo()` answers with an empty config directory (Claude 0.3.296).
const SIGNED_OUT = { tokenSource: "none", apiProvider: "firstParty" } as const;
const NOT_LOGGED_IN = "Not logged in · Please run /login";

const LOCKED = {
  state: "authentication-required",
  message: CLAUDE_SIGN_IN_REQUIRED_MESSAGE,
  signIn: { kind: "terminal", hint: "Open a Claude terminal tab and run /login." },
};

/** Run one turn that Claude refuses for want of a login, then answer its account probe. */
async function refuseTurnForMissingLogin(): Promise<void> {
  const session = createSession("Signed out");
  track(session.id);
  const turn = sendPrompt(session.id, "hello");
  const call = await nextQueryCall();
  call.push({
    type: "assistant",
    uuid: "not-logged-in",
    error: "authentication_failed",
    message: {
      id: "not-logged-in-message",
      role: "assistant",
      content: [{ type: "text", text: NOT_LOGGED_IN }],
    },
  });
  call.push({ type: "result", subtype: "success", is_error: true, result: NOT_LOGGED_IN });
  call.finish();
  await expect(turn).rejects.toThrow();
  const probe = await nextQueryCall();
  expect(probe.options).toMatchObject({ maxTurns: 0 });
  await waitFor(() => probe.isClosed());
}

describe("Claude account normalization", () => {
  test("reads Claude's literal 'none' source as no login", () => {
    expect(normalizeClaudeAccount(SIGNED_OUT)).toEqual({
      state: "needs-auth",
      signIn: LOCKED.signIn,
      signOut: false,
    });
  });

  test.each([
    [{ apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }, undefined],
    [
      { tokenSource: "claude.ai", subscriptionType: "max" },
      { label: "max", plan: "max" },
    ],
    [{ tokenSource: "none", apiProvider: "bedrock" }, { label: "bedrock" }],
  ] as const)("counts %o as signed in", (account, expected) => {
    const status = normalizeClaudeAccount(account);
    expect(status.state).toBe("signed-in");
    expect(status.account).toEqual(expected);
  });
});

describe("Claude prompt admission", () => {
  test("stays unknown until an account read has found no login", () => {
    expect(claudeReadiness()).toBeUndefined();
  });

  test("a refused turn re-reads the account and locks every session", async () => {
    queryControlOverrides.accountInfo = mock(async () => SIGNED_OUT);

    await refuseTurnForMissingLogin();

    await waitFor(() => claudeReadiness() !== undefined);
    expect(claudeReadiness()).toEqual(LOCKED);
    expect((await readClaudeAuthStatus()).state).toBe("needs-auth");
  });

  test("a refused turn with a credential present stays a turn error", async () => {
    // An expired login still has a source; the probe cannot tell it from a good one.
    queryControlOverrides.accountInfo = mock(async () => ({ tokenSource: "claude.ai" }));

    await refuseTurnForMissingLogin();

    expect((await readClaudeAuthStatus()).state).toBe("signed-in");
    expect(claudeReadiness()).toBeUndefined();
  });

  test("a failed account read never locks", async () => {
    queryControlOverrides.accountInfo = mock(async () => {
      throw new Error("probe failed");
    });

    noteClaudeAuthenticationFailure();
    const probe = await nextQueryCall();
    await waitFor(() => probe.isClosed());

    expect((await readClaudeAuthStatus()).state).toBe("unknown");
    expect(claudeReadiness()).toBeUndefined();
  });

  test("a model answer clears a cached missing login", async () => {
    queryControlOverrides.accountInfo = mock(async () => SIGNED_OUT);
    await refuseTurnForMissingLogin();
    await waitFor(() => claudeReadiness() !== undefined);

    const session = createSession("Answered");
    track(session.id);
    const turn = sendPrompt(session.id, "hello");
    const call = await nextQueryCall();
    call.push({
      type: "assistant",
      uuid: "answer",
      message: { id: "answer-message", role: "assistant", content: [{ type: "text", text: "Hi" }] },
    });
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await turn;

    expect(claudeReadiness()).toBeUndefined();
  });

  test("re-reads an expired lock in the background so a terminal login unlocks the tab", async () => {
    const accountInfo = mock(async (): Promise<Record<string, string>> => SIGNED_OUT);
    queryControlOverrides.accountInfo = accountInfo;
    await refuseTurnForMissingLogin();
    await waitFor(() => claudeReadiness() !== undefined);

    accountInfo.mockImplementation(async () => ({ tokenSource: "claude.ai" }));
    const now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now + 31_000);
    try {
      // The stale answer still stands while the re-read runs.
      expect(claudeReadiness()).toEqual(LOCKED);
      const probe = await nextQueryCall();
      await waitFor(() => probe.isClosed());
      await waitFor(() => claudeReadiness() === undefined);
    } finally {
      clock.mockRestore();
    }
    expect(accountInfo).toHaveBeenCalledTimes(2);
  });
});
