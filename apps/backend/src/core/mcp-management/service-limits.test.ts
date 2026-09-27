import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  MCP_MANAGEMENT_CHANGED_EVENT,
  MCP_MANAGEMENT_LIMITS,
  mcpFailure,
  mcpManagementErrorFromUnknown,
  utf8ByteLength,
  type McpManagementChangedEvent,
} from "@orkestrator/protocol/mcp-management";

import { createCommandRegistry } from "../commands.js";
import type { CommandContext } from "../commands-context.js";
import {
  SENTINEL,
  createFixture,
  entry,
  mutation,
  revision,
  targetIdFor,
  type Fixture,
} from "./test-support.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.cleanup();
});

function claudeServers(servers: Record<string, unknown>) {
  fixture.write("home/.claude.json", JSON.stringify({ mcpServers: servers }, null, 2));
}

async function claudeAdd(name: string, intent: "save" | "save-and-apply" = "save") {
  const targetId = await targetIdFor(fixture, "claude", "backend");
  const snapshot = await fixture.service.snapshot({ targetId });
  return mutation(
    targetId,
    {
      kind: "add",
      sourceId: "claude:user",
      expectedRevision: revision(snapshot, "claude:user"),
      definition: { name, transport: "stdio", command: "x" },
    },
    intent,
  );
}

async function codeOf(promise: Promise<unknown>) {
  return mcpManagementErrorFromUnknown(await promise.catch((error: unknown) => error))?.code;
}

describe("admission limits", () => {
  test("a source holding the per-source maximum refuses another definition", async () => {
    const servers: Record<string, unknown> = {};
    for (let index = 0; index < MCP_MANAGEMENT_LIMITS.definitionsPerSource; index += 1)
      servers[`s${index}`] = { command: "x" };
    claudeServers(servers);
    const before = fixture.read("home/.claude.json");
    expect(await codeOf(fixture.service.mutate(await claudeAdd("one-more")))).toBe(
      "oversized-source",
    );
    expect(await codeOf(fixture.service.validate(await claudeAdd("one-more")))).toBe(
      "oversized-source",
    );
    expect(fixture.read("home/.claude.json")).toBe(before);
  });

  test("an edit that grows the server map past its byte budget is refused", async () => {
    const servers: Record<string, unknown> = {};
    const arg = "a".repeat(4 * 1024);
    // ~1.3 MiB across fewer entries than the count limit.
    for (let index = 0; index < 63; index += 1)
      servers[`s${index}`] = { command: "x", args: [arg, arg, arg, arg, arg] };
    claudeServers(servers);
    const before = fixture.read("home/.claude.json");
    expect(await codeOf(fixture.service.mutate(await claudeAdd("grow")))).toBe("oversized-source");
    expect(fixture.read("home/.claude.json")).toBe(before);
    // No operation record is created for a refused change.
    const operations = path.join(fixture.dataDir, "mcp-management", "operations.json");
    expect(existsSync(operations) && readFileSync(operations, "utf8").includes('"grow"')).toBe(
      false,
    );

    // Shrinking an over-budget map is still allowed.
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    const removed = await fixture.service.mutate(
      mutation(targetId, {
        kind: "remove",
        entryId: entry(snapshot, "claude:user", "s0").entryId,
        expectedRevision: revision(snapshot, "claude:user")!,
      }),
    );
    expect(removed.operation.phase).toBe("saved");
  });

  test("a snapshot over the response budget is truncated and marked incomplete", async () => {
    const servers: Record<string, unknown> = {};
    for (let index = 0; index < 90; index += 1)
      servers[`s${String(index).padStart(2, "0")}`] = {
        command: `/opt/tools/${"c".repeat(3_900)}`,
      };
    claudeServers(servers);
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "claude", "backend"),
    });
    expect(snapshot.truncated).toBeGreaterThan(0);
    expect(snapshot.freshness).toBe("incomplete");
    // 90 saved rows plus Orkestrator's injected rows.
    expect(snapshot.definitions.length + snapshot.truncated).toBeGreaterThanOrEqual(90);
    expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
      MCP_MANAGEMENT_LIMITS.catalogMaxBytes,
    );
  });
});

describe("backend-user edits through the service", () => {
  test("clearing an env key and switching transport rewrite only what they name", async () => {
    claudeServers({
      svc: {
        type: "stdio",
        command: "npx",
        args: ["-y", "svc"],
        env: { KEY: SENTINEL, OTHER: "${REF}" },
        custom: { keep: true },
      },
    });
    const targetId = await targetIdFor(fixture, "claude", "backend");
    let snapshot = await fixture.service.snapshot({ targetId });
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "update",
        entryId: entry(snapshot, "claude:user", "svc").entryId,
        expectedRevision: revision(snapshot, "claude:user")!,
        patch: { env: [{ key: "KEY", edit: { kind: "clear" } }] },
      }),
    );
    let saved = JSON.parse(fixture.read("home/.claude.json")).mcpServers.svc;
    expect(saved.env).toEqual({ OTHER: "${REF}" });
    expect(saved.args).toEqual(["-y", "svc"]);
    expect(saved.custom).toEqual({ keep: true });

    snapshot = await fixture.service.snapshot({ targetId });
    const switchTo = (discard: string[]) =>
      fixture.service.mutate(
        mutation(targetId, {
          kind: "update",
          entryId: entry(snapshot, "claude:user", "svc").entryId,
          expectedRevision: revision(snapshot, "claude:user")!,
          patch: {
            transport: { to: "http", discard },
            url: { kind: "set", value: "https://svc.example/mcp" },
            env: [{ key: "OTHER", edit: { kind: "clear" } }],
          },
        }),
      );
    // An unconfirmed switch never drops fields silently.
    await expect(switchTo([])).rejects.toThrow("confirm the switch");
    await switchTo(["command", "args"]);
    saved = JSON.parse(fixture.read("home/.claude.json")).mcpServers.svc;
    expect(saved.url).toBe("https://svc.example/mcp");
    expect(saved.command).toBeUndefined();
    expect(saved.args).toBeUndefined();
    expect(saved.custom).toEqual({ keep: true });
  });
});

describe("previews", () => {
  test("a stdio add warns about command execution for either intent", async () => {
    const save = await fixture.service.validate(await claudeAdd("s", "save"));
    expect(save.preview?.warnings.some((warning) => warning.startsWith("If you apply"))).toBe(true);
    const apply = await fixture.service.validate(await claudeAdd("s", "save-and-apply"));
    expect(apply.preview?.warnings.some((warning) => warning.startsWith("Applying starts"))).toBe(
      true,
    );
  });

  test("the container warning is provider-aware", async () => {
    const cursorTarget = await targetIdFor(fixture, "cursor", "backend");
    const cursorSnapshot = await fixture.service.snapshot({ targetId: cursorTarget });
    const cursor = await fixture.service.validate(
      mutation(cursorTarget, {
        kind: "add",
        sourceId: "cursor:user",
        expectedRevision: revision(cursorSnapshot, "cursor:user"),
        definition: { name: "c", transport: "http", url: "https://c.example/mcp" },
      }),
    );
    expect(cursor.preview?.warnings).toContain(
      "Container environments do not receive Cursor's MCP configuration.",
    );
    expect(cursor.preview?.warnings.join(" ")).not.toContain("keep the copy");
    const claude = await fixture.service.validate(await claudeAdd("c"));
    expect(claude.preview?.warnings).toContain(
      "Existing container environments keep the copy they were created with.",
    );
  });
});

describe("events and operation records", () => {
  test("a saved change names the targets whose catalog changed", async () => {
    const targetId = await targetIdFor(fixture, "claude", "backend");
    await fixture.service.mutate(await claudeAdd("evt"));
    const events = fixture.events
      .filter(([name]) => name === MCP_MANAGEMENT_CHANGED_EVENT)
      .map(([, payload]) => payload as McpManagementChangedEvent);
    const last = events.at(-1)!;
    expect(last.targetIds).toContain(targetId);
    // A backend-user file is also what every environment's target reads.
    const environmentTarget = await targetIdFor(fixture, "claude", "environment");
    expect(last.targetIds).toContain(environmentTarget);
    expect(last.operationIds).toHaveLength(1);
  });

  test("operations record their impact scope and runtimes the revision they adopt", async () => {
    fixture.sessions.push({
      environmentId: "env-1",
      agent: "claude",
      logicalSessionKey: "env-env-1:tab-a",
      pendingDispatch: false,
      coordinator: false,
    });
    const result = await fixture.service.mutate(await claudeAdd("scoped", "save-and-apply"));
    expect(result.operation.affectedEnvironments).toEqual([
      { environmentId: "env-1", name: "env-one", activeSessions: 0 },
    ]);
    expect(result.operation.apply.runtimes[0]!.savedRevision).toBe(result.savedRevision);
    const reloaded = fixture.newService();
    try {
      const stored = await reloaded.getOperation({ operationId: result.operation.operationId });
      expect(stored.affectedEnvironments).toHaveLength(1);
      expect(stored.apply.runtimes[0]!.savedRevision).toBe(result.savedRevision);
    } finally {
      reloaded.dispose();
    }
  });
});

describe("secrets never reach durable records or logs", () => {
  test("add, update and failure paths keep the sentinel out of operations.json and console", async () => {
    const lines: string[] = [];
    const capture = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
    const spies = [
      spyOn(console, "log").mockImplementation(capture),
      spyOn(console, "info").mockImplementation(capture),
      spyOn(console, "warn").mockImplementation(capture),
      spyOn(console, "error").mockImplementation(capture),
    ];
    try {
      const commands = createCommandRegistry();
      const context = {
        mcpManagement: fixture.service,
        emit: () => undefined,
      } as unknown as CommandContext;
      const invoke = (name: string, args: Record<string, unknown>) =>
        Promise.resolve(commands.get(name)!(args, context)).catch((error: unknown) => error);
      const targetId = await targetIdFor(fixture, "claude", "backend");
      let snapshot = await fixture.service.snapshot({ targetId });
      const secretAdd = (name: string) =>
        mutation(targetId, {
          kind: "add",
          sourceId: "claude:user",
          expectedRevision: revision(snapshot, "claude:user"),
          definition: {
            name,
            transport: "stdio",
            command: "npx",
            args: ["--token", SENTINEL],
            env: [{ key: "API_KEY", value: SENTINEL }],
          },
        });
      await invoke("mutate_mcp_definition", secretAdd("secret"));
      snapshot = await fixture.service.snapshot({ targetId });
      await invoke(
        "mutate_mcp_definition",
        mutation(targetId, {
          kind: "update",
          entryId: entry(snapshot, "claude:user", "secret").entryId,
          expectedRevision: revision(snapshot, "claude:user")!,
          patch: { env: [{ key: "API_KEY", edit: { kind: "set", value: `${SENTINEL}-2` } }] },
        }),
      );
      // Failures: a duplicate, a stale revision, an invalid value and a failed write.
      snapshot = await fixture.service.snapshot({ targetId });
      await invoke("mutate_mcp_definition", secretAdd("secret"));
      await invoke(
        "mutate_mcp_definition",
        mutation(targetId, {
          kind: "add",
          sourceId: "claude:user",
          expectedRevision: "r1.stale",
          definition: { name: "stale", transport: "stdio", command: SENTINEL },
        }),
      );
      await invoke(
        "mutate_mcp_definition",
        mutation(targetId, {
          kind: "add",
          sourceId: "claude:user",
          expectedRevision: revision(snapshot, "claude:user"),
          definition: { name: "bad", transport: "http", url: `not a url ${SENTINEL}` },
        }),
      );
      const store = (
        fixture.service as unknown as { store: { commit: (...args: never[]) => unknown } }
      ).store;
      const commit = store.commit.bind(store);
      store.commit = async () => {
        throw mcpFailure("internal", { message: "The disk is full; the file was left unchanged." });
      };
      await invoke("mutate_mcp_definition", secretAdd("full"));
      store.commit = commit;

      expect(JSON.parse(fixture.read("home/.claude.json")).mcpServers.secret.env.API_KEY).toBe(
        `${SENTINEL}-2`,
      );
      const operations = readFileSync(
        path.join(fixture.dataDir, "mcp-management", "operations.json"),
        "utf8",
      );
      expect(operations).toContain('"full"');
      expect(operations).not.toContain(SENTINEL);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).not.toContain(SENTINEL);
      expect(JSON.stringify(fixture.events)).not.toContain(SENTINEL);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
