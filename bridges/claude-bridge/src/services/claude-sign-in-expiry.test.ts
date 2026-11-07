/**
 * A claude.ai login's end (`credential_expires_at` on a result) reaches the
 * account the bridge serves, for that account only.
 */
import { describe, expect, mock, test } from "bun:test";

import {
  createSession,
  nextQueryCall,
  queryControlOverrides,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";
import {
  claudeCredentialAccountKey,
  normalizeClaudeAccount,
  noteClaudeCredentialExpiry,
  readClaudeAuthStatus,
  resetClaudeSignInForTesting,
} from "./claude-sign-in.js";
import { expectAuthStatusShape } from "../../../../tests/helpers/auth-secret-canaries.js";

const TEAM_A = {
  email: "a@example.test",
  tokenSource: "claude.ai",
  subscriptionType: "max",
  organization: "Team A",
};
const TEAM_B = {
  email: "b@example.test",
  tokenSource: "claude.ai",
  subscriptionType: "max",
  organization: "Team B",
};
const ENDS = "2026-12-03T10:00:00.000Z";

/** The account a CLI launched with, and the one the bridge's probe sees now. */
function accounts(launched: object, current: object = launched): void {
  queryControlOverrides.initializationResult = mock(async () => ({ account: launched }));
  queryControlOverrides.accountInfo = mock(async () => current);
}

/** Run one turn whose result carries `result`'s extra fields. */
async function finishTurnWith(result: Record<string, unknown>): Promise<void> {
  const session = createSession("Login end");
  track(session.id);
  const turn = sendPrompt(session.id, "hello");
  const call = await nextQueryCall();
  call.push({ type: "result", subtype: "success", ...result });
  call.finish();
  await turn;
  // The record waits on the CLI's held initialize answer, never on the turn.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("Claude login end", () => {
  test("a result's date is served as an estimate beside the same account", async () => {
    accounts(TEAM_A);
    await finishTurnWith({ result_index: 0, credential_expires_at: "2026-12-03T10:00:00Z" });

    const status = await readClaudeAuthStatus();
    expectAuthStatusShape(status);
    expect(status.account).toEqual({
      label: "Team A",
      plan: "max",
      expiresAt: ENDS,
      expiresAtEstimated: true,
    });
  });

  test("a different login never inherits another account's date", async () => {
    accounts(TEAM_A, TEAM_B);
    await finishTurnWith({ result_index: 0, credential_expires_at: ENDS });

    const status = await readClaudeAuthStatus();
    expect(status.account).toEqual({ label: "Team B", plan: "max" });
  });

  test("different emails sharing the same organization and plan do not share expiry", async () => {
    accounts(TEAM_A, { ...TEAM_A, email: "other@example.test" });
    await finishTurnWith({ result_index: 0, credential_expires_at: ENDS });
    const status = await readClaudeAuthStatus();
    expectAuthStatusShape(status);
    expect(status.account).toEqual({ label: "Team A", plan: "max" });
    expect(JSON.stringify(status)).not.toContain("example.test");
  });

  test("different credential sources do not share expiry", async () => {
    accounts(TEAM_A, { ...TEAM_A, tokenSource: "environment" });
    await finishTurnWith({ result_index: 0, credential_expires_at: ENDS });
    expect((await readClaudeAuthStatus()).account).toEqual({ label: "Team A", plan: "max" });
  });

  test("missing private identity never receives an expiry", async () => {
    accounts({ tokenSource: "claude.ai", organization: "Team A", subscriptionType: "max" });
    await finishTurnWith({ result_index: 0, credential_expires_at: ENDS });
    expect((await readClaudeAuthStatus()).account).toEqual({ label: "Team A", plan: "max" });
  });

  test("a numbered result without a date drops the account's date", async () => {
    accounts(TEAM_A);
    noteClaudeCredentialExpiry(claudeCredentialAccountKey(normalizeClaudeAccount(TEAM_A)), {
      credential_expires_at: ENDS,
    });
    expect((await readClaudeAuthStatus()).account?.expiresAt).toBe(ENDS);
    // That read spawned an account probe; take it so the turn gets its own query.
    const probe = await nextQueryCall();
    await waitFor(() => probe.isClosed());

    await finishTurnWith({ result_index: 1 });

    expect((await readClaudeAuthStatus()).account).toEqual({ label: "Team A", plan: "max" });
  });

  test("an unnumbered result without a date keeps it", async () => {
    accounts(TEAM_A);
    noteClaudeCredentialExpiry(claudeCredentialAccountKey(normalizeClaudeAccount(TEAM_A)), {
      credential_expires_at: ENDS,
    });
    await finishTurnWith({});

    expect((await readClaudeAuthStatus()).account?.expiresAt).toBe(ENDS);
  });

  test.each([["not a date"], [1_764_756_000_000], [""]])(
    "an unreadable date %p is no date",
    async (value) => {
      accounts(TEAM_A);
      await finishTurnWith({ result_index: 0, credential_expires_at: value });

      expect((await readClaudeAuthStatus()).account).toEqual({ label: "Team A", plan: "max" });
    },
  );

  test("an API-key login has no account to carry a date", async () => {
    accounts({ apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" });
    await finishTurnWith({ result_index: 0, credential_expires_at: ENDS });

    const status = await readClaudeAuthStatus();
    expect(status.state).toBe("signed-in");
    expect(status.account).toBeUndefined();
  });

  test("a reset forgets the date", async () => {
    accounts(TEAM_A);
    noteClaudeCredentialExpiry(claudeCredentialAccountKey(normalizeClaudeAccount(TEAM_A)), {
      credential_expires_at: ENDS,
    });
    resetClaudeSignInForTesting();

    expect((await readClaudeAuthStatus()).account).toEqual({ label: "Team A", plan: "max" });
  });
});
