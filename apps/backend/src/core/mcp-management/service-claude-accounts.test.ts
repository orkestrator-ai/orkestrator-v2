/**
 * Added Claude accounts copy the backend user's Claude MCP servers into their
 * own `.claude.json` (0039 item 12). The editor says so on the sources they
 * copy, and a save refreshes every copy, so a CLI an account's bridge starts
 * later loads what was saved.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CLAUDE_ACCOUNT_COPY_NOTE } from "./claude-account-copies.js";
import { createFixture, mutation, revision, targetIdFor, type Fixture } from "./test-support.js";

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

function withAccount(env: NodeJS.ProcessEnv = {}) {
  let accountHome = "";
  const homes = { value: [] as string[] };
  fixture = createFixture({ env, claudeAccountHomes: async () => homes.value });
  accountHome = path.join(fixture.root, "accounts", "claude", "a1");
  mkdirSync(accountHome, { recursive: true });
  const accountJson = path.join(accountHome, ".claude.json");
  writeFileSync(
    accountJson,
    JSON.stringify({
      oauthAccount: { emailAddress: "someone@example.com" },
      mcpServers: { inside: { command: "added-in-the-account" } },
    }),
  );
  return {
    fixture,
    homes,
    accountHome,
    readAccount: () => JSON.parse(readFileSync(accountJson, "utf8")) as Record<string, unknown>,
  };
}

const note = (snapshot: { sources: Array<{ sourceId: string; note?: string }> }, id: string) =>
  snapshot.sources.find((source) => source.sourceId === id)?.note;

describe("Claude account copies", () => {
  test("the copied Claude sources say so only once an account exists", async () => {
    const { fixture, homes, accountHome } = withAccount();
    const backend = await targetIdFor(fixture, "claude", "backend");
    const environment = await targetIdFor(fixture, "claude", "environment");
    expect(note(await fixture.service.snapshot({ targetId: backend }), "claude:user")).toBe(
      undefined,
    );
    homes.value = [accountHome];
    expect(note(await fixture.service.snapshot({ targetId: backend }), "claude:user")).toBe(
      CLAUDE_ACCOUNT_COPY_NOTE,
    );
    const inEnvironment = await fixture.service.snapshot({ targetId: environment });
    expect(note(inEnvironment, "claude:user")).toBe(CLAUDE_ACCOUNT_COPY_NOTE);
    expect(note(inEnvironment, "claude:local")).toBe(CLAUDE_ACCOUNT_COPY_NOTE);
    // A project's `.mcp.json` is read from the worktree on every account.
    expect(note(inEnvironment, "claude:project")).toBeUndefined();
  });

  test("a save refreshes each account's copy and keeps the account's own keys", async () => {
    const { fixture, homes, accountHome, readAccount } = withAccount();
    homes.value = [accountHome];
    const targetId = await targetIdFor(fixture, "claude", "environment");
    let snapshot = await fixture.service.snapshot({ targetId });
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId: "claude:user",
        expectedRevision: revision(snapshot, "claude:user"),
        definition: { name: "saved", transport: "stdio", command: "x" },
      }),
    );
    expect(readAccount()).toMatchObject({
      oauthAccount: { emailAddress: "someone@example.com" },
      mcpServers: { saved: { command: "x" } },
    });
    // Replaced, as at launch: a server added inside the account is gone.
    expect(Object.keys(readAccount().mcpServers as object)).toEqual(["saved"]);

    snapshot = await fixture.service.snapshot({ targetId });
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId: "claude:local",
        expectedRevision: revision(snapshot, "claude:local"),
        definition: { name: "private", transport: "stdio", command: "y" },
      }),
    );
    const projects = readAccount().projects as Record<string, { mcpServers?: object }>;
    expect(Object.keys(projects[fixture.worktree]?.mcpServers ?? {})).toEqual(["private"]);
  });

  test("with the backend's own CLAUDE_CONFIG_DIR, accounts copy another file: no note, no copy", async () => {
    const configDir = "/nonexistent-claude-config-dir";
    const { fixture, homes, accountHome, readAccount } = withAccount({
      CLAUDE_CONFIG_DIR: configDir,
    });
    homes.value = [accountHome];
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(note(snapshot, "claude:user")).toBeUndefined();
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId: "claude:user",
        expectedRevision: revision(snapshot, "claude:user"),
        definition: { name: "saved", transport: "stdio", command: "x" },
      }),
    );
    expect(Object.keys(readAccount().mcpServers as object)).toEqual(["inside"]);
  });

  test("an account list that cannot be read changes nothing", async () => {
    fixture = createFixture({
      claudeAccountHomes: async () => {
        throw new Error("store unavailable");
      },
    });
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(note(snapshot, "claude:user")).toBeUndefined();
    const result = await fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId: "claude:user",
        expectedRevision: revision(snapshot, "claude:user"),
        definition: { name: "saved", transport: "stdio", command: "x" },
      }),
    );
    expect(result.operation.phase).toBe("saved");
  });
});
