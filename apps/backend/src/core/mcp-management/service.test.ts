import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, statSync } from "node:fs";
import path from "node:path";

import { MCP_MANAGEMENT_CHANGED_EVENT, mcpFailure } from "@orkestrator/protocol/mcp-management";

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

const CLAUDE_JSON = JSON.stringify(
  {
    numStartups: 7,
    projects: { "/elsewhere": { history: ["keep me"] } },
    mcpServers: {
      docs: {
        type: "stdio",
        command: "npx",
        args: ["-y", "docs-mcp", "--token", SENTINEL],
        env: { API_KEY: SENTINEL, REF: "${HOME_REF}" },
        custom: { keep: true },
      },
    },
  },
  null,
  2,
);

describe("McpManagementService — catalog", () => {
  test("lists backend targets for every provider and environment targets on request", async () => {
    const backend = await fixture.service.listTargets({});
    expect(backend.targets.map((target) => target.provider).sort()).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]);
    expect(backend.targets.every((target) => target.context.kind === "backend")).toBe(true);
    expect(backend.targets.find((target) => target.provider === "claude")?.defaultSourceId).toBe(
      "claude:user",
    );
    const withEnvironment = await fixture.service.listTargets({ environmentId: "env-1" });
    const environmentTarget = withEnvironment.targets.find(
      (target) => target.context.kind === "environment" && target.provider === "claude",
    )!;
    // An environment deep link never silently selects the shared user file.
    expect(environmentTarget.defaultSourceId).toBeNull();
    expect(environmentTarget.context.environmentName).toBe("env-one");
  });

  test("a snapshot shows sources, injected rows and redacts every secret", async () => {
    fixture.write("home/.claude.json", CLAUDE_JSON);
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "claude", "environment"),
    });
    expect(snapshot.sources.map((source) => [source.sourceId, source.state])).toEqual([
      ["claude:user", "ok"],
      ["claude:local", "ok"],
      ["claude:project", "absent"],
      ["claude:injected", "ok"],
    ]);
    const docs = entry(snapshot, "claude:user", "docs");
    expect(docs.status).toBe("effective");
    expect(docs.preservedFields).toEqual(["custom"]);
    expect(docs.secretCount).toBe(2);
    expect(entry(snapshot, "claude:injected", "orkestrator").status).toBe("protected");
    expect(entry(snapshot, "claude:injected", "orkestrator").actions.remove.supported).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(SENTINEL);
    const definition = await fixture.service.getDefinition({
      targetId: snapshot.target.targetId,
      entryId: docs.entryId,
    });
    expect(JSON.stringify(definition)).not.toContain(SENTINEL);
    expect(definition.env).toEqual([
      { key: "API_KEY", presence: "literal" },
      { key: "REF", presence: "reference", reference: "${HOME_REF}" },
    ]);
    expect(definition.args[3]!.value.kind).toBe("redacted");
  });

  test("snapshots and editable definitions hide literal fallbacks and URL path credentials", async () => {
    fixture.write(
      "home/.claude.json",
      JSON.stringify({
        mcpServers: {
          fallback: { command: "x", env: { KEY: "${API_KEY:-SENTINEL-SECRET-7f3a}" } },
          path: { type: "http", url: "https://example.com/api/SENTINEL-SECRET-7f3a/mcp" },
        },
      }),
    );
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(JSON.stringify(snapshot)).not.toContain(SENTINEL);
    for (const name of ["fallback", "path"]) {
      const definition = await fixture.service.getDefinition({
        targetId,
        entryId: entry(snapshot, "claude:user", name).entryId,
      });
      expect(JSON.stringify(definition)).not.toContain(SENTINEL);
    }
  });

  test("a malformed source is reported, never treated as empty, and refuses writes", async () => {
    fixture.write("home/.claude.json", '{"mcpServers": {');
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(snapshot.sources[0]).toMatchObject({ state: "invalid", writable: false });
    expect(snapshot.freshness).toBe("incomplete");
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "claude:user",
          expectedRevision: snapshot.sources[0]!.revision,
          definition: { name: "a", transport: "stdio", command: "x" },
        }),
      ),
    ).rejects.toThrow("malformed-source");
    expect(fixture.read("home/.claude.json")).toBe('{"mcpServers": {');
  });

  test("same-name entries keep distinct identities and show which one wins", async () => {
    fixture.write("home/.claude.json", CLAUDE_JSON);
    fixture.write(
      "worktree/.mcp.json",
      JSON.stringify({
        mcpServers: { docs: { type: "http", url: "https://project.example/mcp" } },
      }),
    );
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "claude", "environment"),
    });
    const user = entry(snapshot, "claude:user", "docs");
    const project = entry(snapshot, "claude:project", "docs");
    expect(user.entryId).not.toBe(project.entryId);
    expect(project.status).toBe("effective");
    expect(user.status).toBe("shadowed");
    expect(user.shadowedBy).toBe(project.entryId);
    expect(project.shadows).toEqual([user.entryId]);
    expect(snapshot.effective.docs).toBe(project.entryId);
  });

  test("a user entry claiming a protected name is shown as overridden and can only be removed", async () => {
    fixture.write(
      "home/.claude.json",
      JSON.stringify({ mcpServers: { orkestrator: { command: "evil" } } }),
    );
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "claude", "backend"),
    });
    const row = entry(snapshot, "claude:user", "orkestrator");
    expect(row.status).toBe("shadowed");
    expect(row.actions.remove.supported).toBe(true);
  });

  test("container environments are read-only with a specific reason", async () => {
    fixture.environment.environmentType = "containerized";
    const targetId = await targetIdFor(fixture, "claude", "environment");
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(snapshot.target.readOnlyReason).toContain("durable environment overlay");
    expect(snapshot.target.capabilities.operations.add.supported).toBe(false);
    expect(snapshot.sources.map((source) => source.sourceId)).toEqual(["claude:injected"]);
  });

  test("a running container shows its own configuration read-only; a stopped one is offline", async () => {
    fixture.environment.environmentType = "containerized";
    fixture.environment.containerId = "container-1";
    fixture.containerFiles.set(
      "/home/node/.claude.json",
      JSON.stringify({ mcpServers: { inside: { command: "x", env: { K: SENTINEL } } } }),
    );
    fixture.containerFiles.set(
      "/workspace/.mcp.json",
      JSON.stringify({ mcpServers: { proj: { type: "http", url: "https://p.example/mcp" } } }),
    );
    const targetId = await targetIdFor(fixture, "claude", "environment");
    let snapshot = await fixture.service.snapshot({ targetId });
    const home = snapshot.sources.find((source) => source.sourceId === "claude:user")!;
    expect(home).toMatchObject({
      state: "ok",
      writable: false,
      displayPath: "container:/home/node/.claude.json",
    });
    expect(entry(snapshot, "claude:user", "inside").actions.edit.supported).toBe(false);
    expect(entry(snapshot, "claude:project", "proj").status).toBe("effective");
    expect(JSON.stringify(snapshot)).not.toContain(SENTINEL);
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "remove",
          entryId: entry(snapshot, "claude:user", "inside").entryId,
          expectedRevision: home.revision!,
        }),
      ),
    ).rejects.toThrow("read-only-source");
    fixture.environment.status = "stopped";
    snapshot = await fixture.service.snapshot({ targetId });
    expect(snapshot.sources.find((source) => source.sourceId === "claude:user")?.state).toBe(
      "offline",
    );
  });

  test("a stale or foreign target id is refused", async () => {
    await expect(
      fixture.service.snapshot({ targetId: "mcp1~claude~env~env-1~wrongincarn" }),
    ).rejects.toThrow("unknown-target");
    await expect(fixture.service.snapshot({ targetId: "/etc/passwd" })).rejects.toThrow(
      "unknown-target",
    );
  });
});

describe("McpManagementService — writes", () => {
  test("saving a literal token restricts an existing user file to owner-only mode", async () => {
    fixture.write(
      "home/.claude.json",
      JSON.stringify({ mcpServers: { docs: { command: "bun" } } }),
    );
    const file = path.join(fixture.root, "home/.claude.json");
    chmodSync(file, 0o644);
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const before = await fixture.service.snapshot({ targetId });
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "update",
        entryId: entry(before, "claude:user", "docs").entryId,
        expectedRevision: revision(before, "claude:user")!,
        patch: { env: [{ key: "TOKEN", edit: { kind: "set", value: "literal-token" } }] },
      }),
    );
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  test("add, update, rename and remove preserve unrelated JSON and unknown fields", async () => {
    fixture.write("home/.claude.json", CLAUDE_JSON);
    const targetId = await targetIdFor(fixture, "claude", "backend");
    let snapshot = await fixture.service.snapshot({ targetId });
    const added = await fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId: "claude:user",
        expectedRevision: revision(snapshot, "claude:user"),
        definition: {
          name: "remote",
          transport: "http",
          url: "https://mcp.example/mcp",
          headers: [{ key: "Authorization", value: "Bearer ${TOKEN}" }],
        },
      }),
    );
    expect(added.operation.phase).toBe("saved");
    expect(added.entryId).toBe(
      entry(await fixture.service.snapshot({ targetId }), "claude:user", "remote").entryId,
    );

    snapshot = await fixture.service.snapshot({ targetId });
    const docs = entry(snapshot, "claude:user", "docs");
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "update",
        entryId: docs.entryId,
        expectedRevision: revision(snapshot, "claude:user")!,
        patch: {
          // Move the secret to a new key without the renderer ever holding it.
          env: [{ key: "DOCS_API_KEY", edit: { kind: "keep", fromKey: "API_KEY" } }],
          args: [
            { kind: "keep", index: 0 },
            { kind: "keep", index: 1 },
            { kind: "keep", index: 2 },
            { kind: "keep", index: 3 },
            { kind: "set", value: "--quiet" },
          ],
        },
      }),
    );
    snapshot = await fixture.service.snapshot({ targetId });
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "rename",
        entryId: entry(snapshot, "claude:user", "docs").entryId,
        expectedRevision: revision(snapshot, "claude:user")!,
        newName: "docs-v2",
      }),
    );
    const saved = JSON.parse(fixture.read("home/.claude.json"));
    expect(saved.numStartups).toBe(7);
    expect(saved.projects).toEqual({ "/elsewhere": { history: ["keep me"] } });
    expect(saved.mcpServers["docs-v2"]).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "docs-mcp", "--token", SENTINEL, "--quiet"],
      env: { REF: "${HOME_REF}", DOCS_API_KEY: SENTINEL },
      custom: { keep: true },
    });
    expect(saved.mcpServers.remote).toEqual({
      type: "http",
      url: "https://mcp.example/mcp",
      headers: { Authorization: "Bearer ${TOKEN}" },
    });

    snapshot = await fixture.service.snapshot({ targetId });
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "remove",
        entryId: entry(snapshot, "claude:user", "docs-v2").entryId,
        expectedRevision: revision(snapshot, "claude:user")!,
      }),
    );
    expect(Object.keys(JSON.parse(fixture.read("home/.claude.json")).mcpServers)).toEqual([
      "remote",
    ]);
    // Events carry ids only.
    const events = fixture.events.filter(([name]) => name === MCP_MANAGEMENT_CHANGED_EVENT);
    expect(events.length).toBe(4);
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
  });

  test("a stale revision is a conflict and leaves the file untouched", async () => {
    fixture.write("home/.claude.json", CLAUDE_JSON);
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    fixture.write("home/.claude.json", CLAUDE_JSON.replace('"numStartups": 7', '"numStartups": 8'));
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "remove",
          entryId: entry(snapshot, "claude:user", "docs").entryId,
          expectedRevision: revision(snapshot, "claude:user")!,
        }),
      ),
    ).rejects.toThrow("revision-conflict");
    expect(JSON.parse(fixture.read("home/.claude.json")).mcpServers.docs).toBeDefined();
  });

  test("a keep that no longer resolves is refused rather than moving another value", async () => {
    fixture.write("home/.claude.json", CLAUDE_JSON);
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "update",
          entryId: entry(snapshot, "claude:user", "docs").entryId,
          expectedRevision: revision(snapshot, "claude:user")!,
          patch: {
            env: [{ key: "X", edit: { kind: "keep", fromKey: "GONE" } }],
            args: [{ kind: "keep", index: 99 }],
          },
        }),
      ),
    ).rejects.toThrow("invalid-definition");
  });

  test("request ids are idempotent and cannot be reused for a different change", async () => {
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const request = mutation(targetId, {
      kind: "add",
      sourceId: "claude:user",
      expectedRevision: null,
      definition: { name: "a", transport: "stdio", command: "x" },
    });
    const first = await fixture.service.mutate(request);
    // A lost response retried with the same id replays; the file is not written twice.
    const replay = await fixture.service.mutate(request);
    expect(replay.replayed).toBe(true);
    expect(replay.operation.operationId).toBe(first.operation.operationId);
    const different = structuredClone(request);
    (different.mutation.operation as { definition: { command: string } }).definition.command = "y";
    await expect(fixture.service.mutate(different)).rejects.toThrow("request-conflict");
  });

  test("simultaneous retries share the one saved operation", async () => {
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const request = mutation(targetId, {
      kind: "add",
      sourceId: "claude:user",
      expectedRevision: null,
      definition: { name: "once", transport: "stdio", command: "x" },
    });
    const [first, second] = await Promise.all([
      fixture.service.mutate(request),
      fixture.service.mutate(request),
    ]);
    expect(first.operation.operationId).toBe(second.operation.operationId);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(JSON.parse(fixture.read("home/.claude.json")).mcpServers).toEqual({
      once: { type: "stdio", command: "x" },
    });
  });

  test("a retry that arrives while the original is still writing replays its result", async () => {
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const request = mutation(targetId, {
      kind: "add",
      sourceId: "claude:user",
      expectedRevision: null,
      definition: { name: "slow", transport: "stdio", command: "x" },
    });
    const store = (
      fixture.service as unknown as { store: { commit: (...args: never[]) => unknown } }
    ).store;
    const commit = store.commit.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inCommit = new Promise<void>((resolve) => (entered = resolve));
    store.commit = async (...args: never[]) => {
      entered();
      await gate;
      return commit(...args);
    };
    const first = fixture.service.mutate(request);
    await inCommit;
    // The operation record is `pending` now; the retry must wait, not fail.
    const retry = fixture.service.mutate(request);
    release();
    const [original, replayed] = await Promise.all([first, retry]);
    expect(replayed.replayed).toBe(true);
    expect(replayed.operation.operationId).toBe(original.operation.operationId);
    expect(replayed.operation.phase).toBe("saved");
  });

  test("another live backend replays a request saved after its initial load", async () => {
    const second = fixture.newService();
    const targetId = await targetIdFor(fixture, "claude", "backend");
    await second.listTargets({});
    const request = mutation(targetId, {
      kind: "add",
      sourceId: "claude:user",
      expectedRevision: null,
      definition: { name: "shared", transport: "stdio", command: "x" },
    });
    try {
      const first = await fixture.service.mutate(request);
      expect(
        (await second.getOperation({ operationId: first.operation.operationId })).operationId,
      ).toBe(first.operation.operationId);
      expect(
        (await second.snapshot({ targetId })).operations.some(
          (item) => item.operationId === first.operation.operationId,
        ),
      ).toBe(true);
      const replay = await second.mutate(request);
      expect(replay.replayed).toBe(true);
      expect(replay.operation.operationId).toBe(first.operation.operationId);
    } finally {
      second.dispose();
    }
  });

  test("a retry after a definite failure replays that failure; a new request id can succeed", async () => {
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const add = (name: string) =>
      mutation(targetId, {
        kind: "add",
        sourceId: "claude:user",
        expectedRevision: null,
        definition: { name, transport: "stdio", command: "x" },
      });
    const store = (
      fixture.service as unknown as { store: { commit: (...args: never[]) => unknown } }
    ).store;
    const commit = store.commit.bind(store);
    store.commit = async () => {
      throw mcpFailure("internal", { message: "The disk is full; the file was left unchanged." });
    };
    const request = add("full");
    await expect(fixture.service.mutate(request)).rejects.toThrow("disk is full");
    store.commit = commit;
    // Same id: the stored outcome is replayed, the change is never repeated silently.
    await expect(fixture.service.mutate(request)).rejects.toThrow("disk is full");
    const fresh = add("full");
    const saved = await fixture.service.mutate(fresh);
    expect(saved.replayed).toBe(false);
    expect(JSON.parse(fixture.read("home/.claude.json")).mcpServers.full).toBeDefined();
  });

  test("duplicate names, protected names and unsupported transports are refused", async () => {
    fixture.write("home/.claude.json", CLAUDE_JSON);
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    const add = (definition: Record<string, unknown>) =>
      fixture.service.mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "claude:user",
          expectedRevision: revision(snapshot, "claude:user"),
          definition: definition as never,
        }),
      );
    await expect(add({ name: "docs", transport: "stdio", command: "x" })).rejects.toThrow(
      "duplicate-name",
    );
    await expect(add({ name: "orkestrator", transport: "stdio", command: "x" })).rejects.toThrow(
      "invalid-definition",
    );
    await expect(
      add({ name: "stream", transport: "sse", url: "https://a.example" }),
    ).rejects.toThrow("SSE");
  });

  test("project scope refuses new literal secrets but keeps existing ones on unrelated edits", async () => {
    fixture.write(
      "worktree/.mcp.json",
      JSON.stringify(
        {
          mcpServers: {
            svc: { command: "x", args: ["--api-key", SENTINEL], env: { OLD: SENTINEL } },
          },
        },
        null,
        2,
      ),
    );
    const targetId = await targetIdFor(fixture, "claude", "environment");
    let snapshot = await fixture.service.snapshot({ targetId });
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "claude:project",
          expectedRevision: revision(snapshot, "claude:project"),
          definition: {
            name: "new",
            transport: "http",
            url: "https://a.example",
            headers: [{ key: "Authorization", value: "Bearer literal" }],
          },
        }),
      ),
    ).rejects.toThrow("variable reference");
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "update",
        entryId: entry(snapshot, "claude:project", "svc").entryId,
        expectedRevision: revision(snapshot, "claude:project")!,
        patch: {
          args: [
            { kind: "keep", index: 0 },
            { kind: "keep", index: 1 },
            { kind: "set", value: "--flag" },
          ],
          env: [{ key: "NEW", edit: { kind: "set", value: "${NEW_REF}" } }],
        },
      }),
    );
    snapshot = await fixture.service.snapshot({ targetId });
    expect(JSON.parse(fixture.read("worktree/.mcp.json")).mcpServers.svc.env).toEqual({
      OLD: SENTINEL,
      NEW: "${NEW_REF}",
    });
    expect(JSON.parse(fixture.read("worktree/.mcp.json")).mcpServers.svc.args).toEqual([
      "--api-key",
      SENTINEL,
      "--flag",
    ]);
  });

  test("project scope rejects secret fallbacks, URL paths and command arguments", async () => {
    const targetId = await targetIdFor(fixture, "claude", "environment");
    const snapshot = await fixture.service.snapshot({ targetId });
    const add = (definition: Record<string, unknown>) =>
      fixture.service.mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "claude:project",
          expectedRevision: revision(snapshot, "claude:project"),
          definition: { name: "unsafe", ...definition } as never,
        }),
      );
    await expect(
      add({
        transport: "stdio",
        command: "x",
        env: [{ key: "KEY", value: "${API_KEY:-SENTINEL-SECRET-7f3a}" }],
      }),
    ).rejects.toThrow("variable reference");
    await expect(
      add({ transport: "http", url: "https://example.com/api/SENTINEL-SECRET-7f3a/mcp" }),
    ).rejects.toThrow("credentials out of the URL");
    await expect(
      add({ transport: "stdio", command: "x", args: ["--api-key", SENTINEL] }),
    ).rejects.toThrow("variable reference");
  });

  test("private local entries live under the exact worktree key and share the user file's lock", async () => {
    fixture.write("home/.claude.json", CLAUDE_JSON);
    const targetId = await targetIdFor(fixture, "claude", "environment");
    const snapshot = await fixture.service.snapshot({ targetId });
    const results = await Promise.allSettled([
      fixture.service.mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "claude:local",
          expectedRevision: revision(snapshot, "claude:local"),
          definition: { name: "local", transport: "stdio", command: "x" },
        }),
      ),
      fixture.service.mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "claude:user",
          expectedRevision: revision(snapshot, "claude:user"),
          definition: { name: "user2", transport: "stdio", command: "y" },
        }),
      ),
    ]);
    // Both sources are one file: exactly one wins, the other gets a conflict, nothing is lost.
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
    expect(
      String(
        (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
      ),
    ).toContain("revision-conflict");
    const saved = JSON.parse(fixture.read("home/.claude.json"));
    expect(saved.projects["/elsewhere"]).toEqual({ history: ["keep me"] });
    const wrote = saved.projects[fixture.worktree]?.mcpServers?.local ?? saved.mcpServers.user2;
    expect(wrote).toBeDefined();
  });

  test("removal preview names the entry that becomes effective", async () => {
    fixture.write("home/.claude.json", CLAUDE_JSON);
    fixture.write(
      "worktree/.mcp.json",
      JSON.stringify({
        mcpServers: { docs: { type: "http", url: "https://project.example/mcp" } },
      }),
    );
    const targetId = await targetIdFor(fixture, "claude", "environment");
    const snapshot = await fixture.service.snapshot({ targetId });
    const result = await fixture.service.validate(
      mutation(targetId, {
        kind: "remove",
        entryId: entry(snapshot, "claude:project", "docs").entryId,
        expectedRevision: revision(snapshot, "claude:project")!,
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.preview?.revealsEntryId).toBe(entry(snapshot, "claude:user", "docs").entryId);
    expect(result.preview?.sharedWith).toEqual(["grok"]);
    // Validation writes nothing.
    expect(JSON.parse(fixture.read("worktree/.mcp.json")).mcpServers.docs).toBeDefined();
  });
});
