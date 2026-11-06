import { describe, expect, test } from "bun:test";
import {
  agentAccountLoginOf,
  groupAgentAccountLogins,
  normalizePreferredEmail,
  parsePreferredAgentIdentities,
  isPreferredIdentity,
  parseAgentAccountsSnapshot,
  parseHostAgentSignIns,
  type AgentAccountSummary,
} from "./agent-accounts.js";

test("sign-in metadata drops unknown platforms, invalid states, secrets and long sources", () => {
  expect(
    parseHostAgentSignIns({
      grok: { state: "signed-in", source: "x".repeat(300), token: "secret" },
      pi: { state: "invalid" },
      other: { state: "signed-in" },
    }),
  ).toEqual({ grok: { state: "signed-in", source: "x".repeat(120) } });
  for (const value of [null, [], "bad"]) expect(parseHostAgentSignIns(value)).toBeUndefined();
});

const row = {
  id: "default",
  platform: "claude" as const,
  label: "Host",
  isDefault: true,
  isActive: true,
  signedIn: true,
  identity: { email: "test@example.com" },
};
const active = { claude: "default", codex: "default" };

test("peer snapshots retain only validated summary fields", () => {
  expect(
    parseAgentAccountsSnapshot({
      accounts: [{ ...row, token: "secret", identity: { ...row.identity, token: "secret" } }],
      active: { ...active, token: "secret" },
      token: "secret",
    }),
  ).toEqual({ accounts: [row], active });
});

test("malformed peer snapshots and account rows are rejected", () => {
  for (const value of [
    null,
    [],
    { accounts: [], active: null },
    { accounts: [], active: {} },
    ...[
      { ...row, identity: undefined },
      { ...row, identity: [] },
      { ...row, label: null },
      { ...row, signedIn: "true" },
      { ...row, platform: "pi" },
      { ...row, identity: { email: {} } },
    ].map((account) => ({ accounts: [account], active })),
    { accounts: [row, row], active },
  ])
    expect(parseAgentAccountsSnapshot(value)).toBeUndefined();
});

test("preferred emails trim without changing case and enforce the 320-character boundary", () => {
  expect(normalizePreferredEmail("  Work@Example.com ")).toBe("Work@Example.com");
  const longest = `${"a".repeat(308)}@example.com`;
  expect(longest).toHaveLength(320);
  expect(normalizePreferredEmail(longest)).toBe(longest);
  for (const value of [
    undefined,
    null,
    42,
    {},
    [],
    "",
    "   ",
    "not-an-email",
    "@example.com",
    "a@",
    "a@@b",
    "a b@example.com",
    "a@example.com other",
    `a${longest}`,
  ]) {
    expect(normalizePreferredEmail(value)).toBeUndefined();
  }
});

test("preferred maps admit only supported platforms with valid emails", () => {
  expect(
    parsePreferredAgentIdentities({
      claude: "  Work@Example.com ",
      codex: "code@example.com",
      pi: "other@example.com",
      token: "secret",
    }),
  ).toEqual({ claude: "Work@Example.com", codex: "code@example.com" });
  for (const value of [
    undefined,
    null,
    [],
    "bad",
    { claude: " ", codex: 42 },
    { claude: `${"a".repeat(321)}@b` },
  ]) {
    expect(parsePreferredAgentIdentities(value)).toEqual({});
  }
});

test("preferred identity comparisons fold case and trim account emails", () => {
  expect(isPreferredIdentity({ email: " Work@Example.COM " }, "work@example.com")).toBe(true);
  expect(isPreferredIdentity({ email: "other@example.com" }, "work@example.com")).toBe(false);
  expect(isPreferredIdentity({}, "work@example.com")).toBe(false);
  expect(isPreferredIdentity({ email: " " }, "work@example.com")).toBe(false);
  expect(isPreferredIdentity({ email: "work@example.com" }, undefined)).toBe(false);
});

describe("one row per login", () => {
  const entry = (
    id: string,
    email: string | undefined,
    overrides: Partial<AgentAccountSummary> = {},
  ): AgentAccountSummary => ({
    id,
    platform: "claude",
    label: id === "default" ? "Host login" : (email ?? id),
    isDefault: id === "default",
    isActive: false,
    signedIn: true,
    identity: email ? { email } : {},
    ...overrides,
  });

  test("the host login and an added account on one login are one row, named by the added one", () => {
    const logins = groupAgentAccountLogins([
      entry("default", "Shared@Example.com", { isActive: true }),
      entry("added", "shared@example.com"),
      entry("other", "other@example.com"),
    ]);
    expect(logins).toHaveLength(2);
    expect(logins[0]).toMatchObject({
      account: { id: "added", isActive: false },
      isActive: true,
      entryIds: ["added", "default"],
      alsoHostLogin: true,
    });
    expect(agentAccountLoginOf(logins, "default")).toBe(logins[0]);
    expect(agentAccountLoginOf(logins, "other")?.entryIds).toEqual(["other"]);
  });

  test("a signed-out entry, one with no email and another platform stay their own rows", () => {
    const logins = groupAgentAccountLogins([
      entry("default", "shared@example.com"),
      entry("expired", "shared@example.com", { signedIn: false }),
      entry("key-1", undefined),
      entry("key-2", undefined),
      entry("codex", "shared@example.com", { platform: "codex" }),
    ]);
    expect(logins.map((login) => login.entryIds)).toEqual([
      ["default"],
      ["expired"],
      ["key-1"],
      ["key-2"],
      ["codex"],
    ]);
    expect(logins.every((login) => !login.alsoHostLogin)).toBe(true);
  });

  test("of two added twins, the active one names the login", () => {
    const logins = groupAgentAccountLogins([
      entry("first", "shared@example.com"),
      entry("second", "shared@example.com", { isActive: true }),
    ]);
    expect(logins).toEqual([
      expect.objectContaining({ entryIds: ["second", "first"], alsoHostLogin: false }),
    ]);
  });
});
