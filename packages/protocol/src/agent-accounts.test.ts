import { expect, test } from "bun:test";
import { parseAgentAccountsSnapshot, parseHostAgentSignIns } from "./agent-accounts.js";

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
