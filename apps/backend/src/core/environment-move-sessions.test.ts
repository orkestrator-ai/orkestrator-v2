import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claudeProjectSlug,
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

  test("leaves an existing destination store alone", async () => {
    const home = await tempRoot();
    const directory = path.join(home, "orkestrator-bridge");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `dispatch-journal-${codexCwdHash(FROM)}.json`), "old");
    await fs.writeFile(path.join(directory, `dispatch-journal-${codexCwdHash(TO)}.json`), "new");
    await relocateCodexBridgeState(FROM, TO, home);
    expect(
      await fs.readFile(path.join(directory, `dispatch-journal-${codexCwdHash(TO)}.json`), "utf8"),
    ).toBe("new");
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
