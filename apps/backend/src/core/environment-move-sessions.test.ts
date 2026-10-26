import { BridgeSessionStore } from "../../../../bridges/codex-bridge/src/sessions/persistence.js";
import { DispatchJournal } from "../../../../bridges/codex-bridge/src/sessions/dispatch-journal.js";
import { StorageService } from "./storage.js";
import { hostClaudeJsonPath, hostCodexHome } from "./agent-accounts-homes.js";
import osHome from "node:os";
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claudeProjectSlug,
  defaultSessionRelocationHomes,
  codexCwdHash,
  relocateAgentSessionState,
  relocateClaudeTranscripts,
  relocateCodexBridgeState,
  relocateCursorAgents,
} from "./environment-move-sessions.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-move-sessions-")));
  roots.push(root);
  return root;
}

const FROM = "/work/trees/app-feature";
const TO = "/disk/trees/app-feature";

describe("Claude", () => {
  test("slugs match Claude Code, including the hashed form of long paths", () => {
    expect(claudeProjectSlug("/Users/me/work.trees/app_1")).toBe("-Users-me-work-trees-app-1");
    const long = `/${"a".repeat(250)}`;
    const slug = claudeProjectSlug(long);
    expect(slug.startsWith(`-${"a".repeat(199)}-`)).toBe(true);
    expect(slug).toMatch(/^-a{199}-[0-9a-z]+$/);
    expect(claudeProjectSlug(long)).toBe(slug);
  });

  test("moves transcripts and session folders, marking each relocated", async () => {
    const root = await tempRoot();
    const projects = path.join(root, "projects");
    const source = path.join(projects, claudeProjectSlug(FROM));
    const target = path.join(projects, claudeProjectSlug(TO));
    await fs.mkdir(path.join(source, "s1", "subagents"), { recursive: true });
    await fs.writeFile(path.join(source, "s1.jsonl"), '{"cwd":"/work/trees/app-feature"}');
    await fs.writeFile(path.join(source, "s2.jsonl"), "old-s2\n");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "s2.jsonl"), "new-s2\n");

    await relocateClaudeTranscripts(FROM, TO, root);

    const s1 = (await fs.readFile(path.join(target, "s1.jsonl"), "utf8")).split("\n");
    expect(s1[0]).toBe('{"cwd":"/work/trees/app-feature"}');
    expect(JSON.parse(s1[1]!)).toEqual({ type: "relocated", sessionId: "s1", relocatedCwd: TO });
    expect((await fs.stat(path.join(target, "s1", "subagents"))).isDirectory()).toBe(true);
    // An existing transcript at the destination is never overwritten.
    expect(await fs.readFile(path.join(target, "s2.jsonl"), "utf8")).toBe("new-s2\n");
    // A missing source is a no-op.
    await relocateClaudeTranscripts("/missing", TO, root);
  });

  test("copies the .claude.json project entry without replacing one at the destination", async () => {
    const root = await tempRoot();
    const claudeJsonPath = path.join(root, ".claude.json");
    const entry = { mcpServers: { local: { command: "x" } }, hasTrustDialogAccepted: true };
    await fs.writeFile(
      claudeJsonPath,
      JSON.stringify({ oauthAccount: { id: "keep" }, projects: { [FROM]: entry } }),
    );
    const failures = await relocateAgentSessionState([FROM], TO, {
      claudeConfigDir: root,
      claudeJsonPath,
      codexHomes: [],
      cursorStateDir: path.join(root, "cursor"),
    });
    expect(failures).toEqual([]);
    const written = JSON.parse(await fs.readFile(claudeJsonPath, "utf8")) as {
      oauthAccount: unknown;
      projects: Record<string, unknown>;
    };
    expect(written.oauthAccount).toEqual({ id: "keep" });
    expect(written.projects[TO]).toEqual(entry);
    expect(written.projects[FROM]).toEqual(entry);
  });
});

describe("Codex", () => {
  test("re-keys the registry, its records and the dispatch journal", async () => {
    const home = await tempRoot();
    const directory = path.join(home, "orkestrator-bridge");
    const oldHash = codexCwdHash(FROM);
    const newHash = codexCwdHash(TO);
    await fs.mkdir(path.join(directory, `bridge-sessions-${oldHash}`), { recursive: true });
    const session = {
      bridgeSessionId: "b1",
      threadId: "t1",
      cwdHash: oldHash,
      config: { cwd: FROM, model: "m" },
      lastAccessed: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(directory, `bridge-sessions-${oldHash}`, "a.json"),
      JSON.stringify(session),
    );
    await fs.writeFile(
      path.join(directory, `bridge-sessions-${oldHash}.json`),
      JSON.stringify({ version: 2, sessions: [session] }),
    );
    await fs.writeFile(path.join(directory, `dispatch-journal-${oldHash}.json`), "{}");

    await relocateCodexBridgeState(FROM, TO, home);

    const record = JSON.parse(
      await fs.readFile(path.join(directory, `bridge-sessions-${newHash}`, "a.json"), "utf8"),
    ) as typeof session;
    expect(record.cwdHash).toBe(newHash);
    expect(record.config).toEqual({ cwd: TO, model: "m" });
    const legacy = JSON.parse(
      await fs.readFile(path.join(directory, `bridge-sessions-${newHash}.json`), "utf8"),
    ) as { sessions: Array<typeof session> };
    expect(legacy.sessions[0]!.cwdHash).toBe(newHash);
    expect(
      await fs.readFile(path.join(directory, `dispatch-journal-${newHash}.json`), "utf8"),
    ).toBe("{}");
    const remaining = await fs.readdir(directory);
    expect(remaining.some((name) => name.includes(oldHash))).toBe(false);
  });

  test("merges destination records and retries previously published old hashes through persistence", async () => {
    const home = await tempRoot();
    const store = new BridgeSessionStore({ codexHome: home, cwd: FROM });
    const directory = path.join(home, "orkestrator-bridge");
    const source = path.join(directory, `bridge-sessions-${codexCwdHash(FROM)}`);
    const target = path.join(directory, `bridge-sessions-${codexCwdHash(TO)}`);
    const make = (id: string, cwd: string) => ({
      bridgeSessionId: id,
      threadId: `thread-${id}`,
      cwdHash: codexCwdHash(cwd),
      config: { mode: "build" as const, cwd },
      lastAccessed: new Date().toISOString(),
    });
    await store.upsert(make("source", FROM));
    const targetStore = new BridgeSessionStore({ codexHome: home, cwd: TO });
    await targetStore.upsert(make("destination", TO));
    // Simulates the old directory-rename implementation crashing before rekey.
    await fs.writeFile(
      path.join(target, "interrupted.json"),
      JSON.stringify(make("interrupted", FROM)),
    );
    const oldJournal = new DispatchJournal({ codexHome: home, cwd: FROM });
    const newJournal = new DispatchJournal({ codexHome: home, cwd: TO });
    await oldJournal.load();
    await newJournal.load();
    await oldJournal.markPrepared({
      requestId: "old-request",
      bridgeSessionId: "source",
      threadId: "thread-source",
    });
    await newJournal.markPrepared({
      requestId: "new-request",
      bridgeSessionId: "destination",
      threadId: "thread-destination",
    });
    await relocateCodexBridgeState(FROM, TO, home);
    await relocateCodexBridgeState(FROM, TO, home);
    const loaded = await targetStore.load();
    expect(loaded.map((row) => row.bridgeSessionId).sort()).toEqual([
      "destination",
      "interrupted",
      "source",
    ]);
    expect(loaded.every((row) => row.config.cwd === TO)).toBe(true);
    expect(
      await fs.stat(source).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const journal = new DispatchJournal({ codexHome: home, cwd: TO });
    await journal.load();
    expect(journal.classify("old-request").action).toBe("reconcile");
    expect(journal.classify("new-request").action).toBe("reconcile");
  });

  test("keeps conflicting dispatch evidence and reports a migration failure", async () => {
    const home = await tempRoot();
    for (const [cwd, id] of [
      [FROM, "source"],
      [TO, "destination"],
    ]) {
      const journal = new DispatchJournal({ codexHome: home, cwd: cwd! });
      await journal.load();
      await journal.markPrepared({ requestId: "same", bridgeSessionId: id!, threadId: id! });
    }
    await expect(relocateCodexBridgeState(FROM, TO, home)).rejects.toThrow("Conflicting");
    for (const cwd of [FROM, TO]) {
      const journal = new DispatchJournal({ codexHome: home, cwd });
      await journal.load();
      expect(journal.classify("same").action).toBe("reconcile");
    }
  });
});

describe("Cursor", () => {
  test("rewrites the cwd of agents stored for the old folder", async () => {
    const root = await tempRoot();
    const store = path.join(root, "cursor-sdk");
    await fs.mkdir(store, { recursive: true });
    const rows = [
      { agentId: "a1", cwd: FROM, status: "idle" },
      { agentId: "a2", cwd: "/elsewhere", status: "idle" },
    ];
    await fs.writeFile(
      path.join(store, "agents.ndjson"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    await relocateCursorAgents([FROM], TO, root);
    const written = (await fs.readFile(path.join(store, "agents.ndjson"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { agentId: string; cwd: string });
    expect(written).toEqual([
      { agentId: "a1", cwd: TO, status: "idle" } as never,
      { agentId: "a2", cwd: "/elsewhere", status: "idle" } as never,
    ]);
  });
});

test("discovers per-account Codex homes and the host Claude JSON path", async () => {
  const root = await tempRoot();
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const accounts = path.join(storage.agentAccounts.agentAccountsDirectory(), "codex");
  await fs.mkdir(path.join(accounts, "account-one"), { recursive: true });
  await fs.mkdir(path.join(accounts, "account-two"));
  await fs.writeFile(path.join(accounts, "not-an-account"), "fixture");
  const homes = await defaultSessionRelocationHomes("env", { storage });
  expect(homes.codexHomes).toContain(path.join(accounts, "account-one"));
  expect(homes.codexHomes).toContain(path.join(accounts, "account-two"));
  expect(homes.codexHomes).not.toContain(path.join(accounts, "not-an-account"));
  expect(homes.codexHomes).toContain(hostCodexHome());
  expect(homes.claudeJsonPath).toBe(hostClaudeJsonPath());
  expect(hostClaudeJsonPath({}, osHome.homedir())).toBe(
    path.join(osHome.homedir(), ".claude.json"),
  );
});

test("Codex retry preserves destination updates after source unlink failed", async () => {
  const home = await tempRoot();
  const sourceStore = new BridgeSessionStore({ codexHome: home, cwd: FROM });
  const session = {
    bridgeSessionId: "retry",
    threadId: "thread-retry",
    cwdHash: codexCwdHash(FROM),
    config: { mode: "build" as const, cwd: FROM },
    lastAccessed: new Date().toISOString(),
  };
  await sourceStore.upsert(session);
  const remove = fs.rm.bind(fs);
  const unlink = spyOn(fs, "rm").mockImplementation(async (file, options) => {
    if (String(file).includes(`bridge-sessions-${codexCwdHash(FROM)}/`))
      throw Object.assign(new Error("unlink failed"), { code: "EIO" });
    return remove(file, options);
  });
  try {
    await expect(relocateCodexBridgeState(FROM, TO, home)).rejects.toThrow("unlink failed");
  } finally {
    unlink.mockRestore();
  }
  const destination = new BridgeSessionStore({ codexHome: home, cwd: TO });
  const rows = await destination.load();
  const updated = {
    ...rows[0]!,
    lastAccessed: new Date(Date.now() + 1_000).toISOString(),
    config: { ...rows[0]!.config, model: "updated-model" },
  };
  await destination.upsert(updated);
  await relocateCodexBridgeState(FROM, TO, home);
  expect(await destination.load()).toEqual([updated]);
  expect(await fs.readdir(path.join(home, "orkestrator-bridge"))).not.toContain(
    `bridge-sessions-${codexCwdHash(FROM)}`,
  );
});

test("Cursor read errors are retryable failures and missing stores are harmless", async () => {
  const root = await tempRoot();
  const file = path.join(root, "cursor-sdk", "agents.ndjson");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ agentId: "a1", cwd: FROM }) + "\n");
  const read = spyOn(fs, "readFile").mockRejectedValueOnce(
    Object.assign(new Error("read failed"), { code: "EIO" }),
  );
  try {
    await expect(relocateCursorAgents([FROM], TO, root)).rejects.toThrow("read failed");
  } finally {
    read.mockRestore();
  }
  await relocateCursorAgents([FROM], TO, root);
  expect(JSON.parse(await fs.readFile(file, "utf8")).cwd).toBe(TO);
  await expect(
    relocateCursorAgents([FROM], TO, path.join(root, "missing")),
  ).resolves.toBeUndefined();
});
