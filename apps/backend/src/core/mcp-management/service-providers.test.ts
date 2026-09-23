import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

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
  fixture = createFixture({ env: { XDG_CONFIG_HOME: undefined } });
});

afterEach(() => {
  fixture.cleanup();
});

async function crud(
  provider: AgentPlatform,
  sourceId: string,
  kind: "backend" | "environment" = "backend",
) {
  const targetId = await targetIdFor(fixture, provider, kind);
  const snap = () => fixture.service.snapshot({ targetId });
  let snapshot = await snap();
  await fixture.service.mutate(
    mutation(targetId, {
      kind: "add",
      sourceId,
      expectedRevision: revision(snapshot, sourceId),
      definition: {
        name: "fixture-a",
        transport: "stdio",
        command: "/opt/My Tools/server",
        args: ["--flag", "a b;c"],
        env: [{ key: "API_KEY", value: SENTINEL }],
      },
    }),
  );
  snapshot = await snap();
  await fixture.service.mutate(
    mutation(targetId, {
      kind: "update",
      entryId: entry(snapshot, sourceId, "fixture-a").entryId,
      expectedRevision: revision(snapshot, sourceId)!,
      patch: {
        args: [
          { kind: "keep", index: 0 },
          { kind: "set", value: "second" },
        ],
      },
    }),
  );
  snapshot = await snap();
  await fixture.service.mutate(
    mutation(targetId, {
      kind: "rename",
      entryId: entry(snapshot, sourceId, "fixture-a").entryId,
      expectedRevision: revision(snapshot, sourceId)!,
      newName: "fixture-b",
    }),
  );
  snapshot = await snap();
  expect(JSON.stringify(snapshot)).not.toContain(SENTINEL);
  const renamed = entry(snapshot, sourceId, "fixture-b");
  expect(renamed.command).toEqual({ kind: "visible", value: "/opt/My Tools/server" });
  expect(renamed.argCount).toBe(2);
  return {
    targetId,
    snapshot,
    renamed,
    remove: async () => {
      const latest = await snap();
      await fixture.service.mutate(
        mutation(targetId, {
          kind: "remove",
          entryId: entry(latest, sourceId, "fixture-b").entryId,
          expectedRevision: revision(latest, sourceId)!,
        }),
      );
    },
  };
}

describe("provider adapters", () => {
  test("Codex: TOML CRUD keeps comments, other tables and advanced fields", async () => {
    fixture.write(
      "home/.codex/config.toml",
      `# my codex settings\nmodel = "o3"\n\n[mcp_servers.existing]\ncommand = "keep"\nstartup_timeout_sec = 20.0\ntool_timeout_sec = 60\nenv_vars = ["PATH"]\n\n[profiles.p]\nmodel = "x"\n`,
    );
    const { remove, snapshot } = await crud("codex", "codex:user");
    let text = fixture.read("home/.codex/config.toml");
    expect(text).toContain("# my codex settings");
    expect(text).toContain("startup_timeout_sec = 20.0");
    const parsed = Bun.TOML.parse(text) as any;
    expect(parsed.mcp_servers["fixture-b"]).toEqual({
      command: "/opt/My Tools/server",
      args: ["--flag", "second"],
      env: { API_KEY: SENTINEL },
    });
    expect(parsed.profiles.p.model).toBe("x");
    expect(entry(snapshot, "codex:user", "existing").preservedFields).toEqual(["env_vars"]);
    // Persistent enable is a native Codex field.
    await fixture.service.mutate(
      mutation(snapshot.target.targetId, {
        kind: "set-enabled",
        entryId: entry(snapshot, "codex:user", "existing").entryId,
        expectedRevision: revision(snapshot, "codex:user")!,
        enabled: false,
      }),
    );
    expect(
      (Bun.TOML.parse(fixture.read("home/.codex/config.toml")) as any).mcp_servers.existing.enabled,
    ).toBe(false);
    await remove();
    text = fixture.read("home/.codex/config.toml");
    expect((Bun.TOML.parse(text) as any).mcp_servers["fixture-b"]).toBeUndefined();
    expect(text).toContain("[profiles.p]");
  });

  test("Codex: names outside Codex's grammar are refused and CODEX_HOME is honoured", async () => {
    const custom = `${fixture.root}/custom-codex`;
    fixture.cleanup();
    fixture = createFixture({ env: { CODEX_HOME: custom } });
    const targetId = await targetIdFor(fixture, "codex", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(snapshot.sources[0]!.displayPath).toBe(`${custom}/config.toml`);
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "codex:user",
          expectedRevision: null,
          definition: { name: "has.dot", transport: "stdio", command: "x" },
        }),
      ),
    ).rejects.toThrow("letters, digits");
  });

  test("OpenCode: JSONC CRUD keeps comments and maps command arrays", async () => {
    fixture.write(
      "home/.config/opencode/opencode.jsonc",
      `{\n  // keep this comment\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "tokyonight",\n  "mcp": {\n    "remote": { "type": "remote", "url": "https://r.example/mcp", "oauth": { "clientId": "abc" } },\n  },\n}\n`,
    );
    const { remove, snapshot } = await crud("opencode", "opencode:user-opencode.jsonc");
    const text = fixture.read("home/.config/opencode/opencode.jsonc");
    expect(text).toContain("// keep this comment");
    const parsed = Bun.JSONC.parse(text) as any;
    expect(parsed.mcp["fixture-b"]).toEqual({
      type: "local",
      command: ["/opt/My Tools/server", "--flag", "second"],
      environment: { API_KEY: SENTINEL },
      enabled: true,
    });
    // The OAuth object is not owned by the form and survives.
    expect(entry(snapshot, "opencode:user-opencode.jsonc", "remote").preservedFields).toEqual([
      "oauth",
    ]);
    await remove();
    expect(
      (Bun.JSONC.parse(fixture.read("home/.config/opencode/opencode.jsonc")) as any).mcp.remote
        .oauth,
    ).toEqual({ clientId: "abc" });
  });

  test("OpenCode: a project entry deep-merges over the user entry and says so", async () => {
    fixture.write(
      "home/.config/opencode/opencode.json",
      JSON.stringify({ mcp: { db: { type: "local", command: ["db"] } } }),
    );
    fixture.write(
      "worktree/opencode.json",
      JSON.stringify({ mcp: { db: { type: "local", command: ["db2"], enabled: false } } }),
    );
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "opencode", "environment"),
    });
    expect(entry(snapshot, "opencode:project-opencode.json", "db").status).toBe("disabled");
    expect(entry(snapshot, "opencode:user-opencode.json", "db").statusReason).toContain(
      "deep-merges",
    );
  });

  test("Cursor: user CRUD works while host project settings are shown as excluded", async () => {
    fixture.write(
      "worktree/.cursor/mcp.json",
      JSON.stringify({ mcpServers: { proj: { url: "https://p.example/mcp" } } }),
    );
    await crud("cursor", "cursor:user", "environment");
    const parsed = JSON.parse(fixture.read("home/.cursor/mcp.json"));
    expect(parsed.mcpServers["fixture-b"]).toEqual({
      command: "/opt/My Tools/server",
      args: ["--flag", "second"],
      env: { API_KEY: SENTINEL },
    });
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "cursor", "environment"),
    });
    const project = entry(snapshot, "cursor:project", "proj");
    expect(project.status).toBe("policy-excluded");
    // Editing an excluded project file is still allowed: saving is not execution.
    expect(project.actions.edit.supported).toBe(true);
    expect(snapshot.sources.find((source) => source.sourceId === "cursor:project")?.trust).toBe(
      "excluded",
    );
  });

  test("Grok: native TOML CRUD, compatibility sources read-only and below native", async () => {
    fixture.write(
      "home/.claude.json",
      JSON.stringify({ mcpServers: { shared: { command: "claude-one" } } }),
    );
    fixture.write("home/.grok/config.toml", `[mcp_servers.shared]\ncommand = "grok-one"\n`);
    await crud("grok", "grok:user", "environment");
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "grok", "environment"),
    });
    expect(entry(snapshot, "grok:user", "shared").status).toBe("effective");
    const compat = entry(snapshot, "grok:compat-claude-user", "shared");
    expect(compat.status).toBe("shadowed");
    expect(compat.actions.edit.supported).toBe(false);
    expect(compat.actions.remove.reason).toContain("Claude Code");
    // Removing the native override reveals the compatibility entry.
    const preview = await fixture.service.validate(
      mutation(snapshot.target.targetId, {
        kind: "remove",
        entryId: entry(snapshot, "grok:user", "shared").entryId,
        expectedRevision: revision(snapshot, "grok:user")!,
      }),
    );
    expect(preview.preview?.revealsEntryId).toBe(compat.entryId);
  });

  test("Grok: [compat] mcps = false marks imported sources excluded", async () => {
    fixture.write("home/.claude.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    fixture.write("home/.grok/config.toml", `[compat.claude]\nmcps = false\n`);
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "grok", "backend"),
    });
    expect(entry(snapshot, "grok:compat-claude-user", "a").status).toBe("policy-excluded");
  });

  test("Pi: wrapped and bare maps, disabled entries and normalized-name collisions", async () => {
    fixture.write(
      "home/.pi/agent/mcp.json",
      JSON.stringify({ "my-server": { command: "x", disabled: true, extra: 1 } }, null, 2),
    );
    const targetId = await targetIdFor(fixture, "pi", "backend");
    let snapshot = await fixture.service.snapshot({ targetId });
    const disabled = entry(snapshot, "pi:user", "my-server");
    expect(disabled.status).toBe("disabled");
    expect(disabled.enabled).toBe(false);
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "pi:user",
          expectedRevision: revision(snapshot, "pi:user"),
          definition: { name: "1bad", transport: "stdio", command: "x" },
        }),
      ),
    ).rejects.toThrow("start with a letter");
    // "my server" is loaded by Pi as "my_server", so that name is taken.
    fixture.write(
      "home/.pi/agent/mcp.json",
      JSON.stringify({ "my server": { command: "x" }, other: { command: "y" } }, null, 2),
    );
    snapshot = await fixture.service.snapshot({ targetId });
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "rename",
          entryId: entry(snapshot, "pi:user", "other").entryId,
          expectedRevision: revision(snapshot, "pi:user")!,
          newName: "my_server",
        }),
      ),
    ).rejects.toThrow("Pi treats this name the same");
    // Bare map is edited in place, not converted.
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "set-enabled",
        entryId: entry(snapshot, "pi:user", "other").entryId,
        expectedRevision: revision(snapshot, "pi:user")!,
        enabled: false,
      }),
    );
    expect(JSON.parse(fixture.read("home/.pi/agent/mcp.json"))).toEqual({
      "my server": { command: "x" },
      other: { command: "y", disabled: true },
    });
  });

  test("Pi: a new file uses the wrapped form and provider limits apply", async () => {
    const targetId = await targetIdFor(fixture, "pi", "backend");
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "pi:user",
          expectedRevision: null,
          definition: {
            name: "many",
            transport: "stdio",
            command: "x",
            args: Array.from({ length: 33 }, () => "a"),
          },
        }),
      ),
    ).rejects.toThrow("at most 32 arguments");
    await crud("pi", "pi:user");
    expect(Object.keys(JSON.parse(fixture.read("home/.pi/agent/mcp.json")))).toEqual([
      "mcpServers",
    ]);
  });

  test("Pi: an SSE-declared entry is visible, not editable, and removable", async () => {
    fixture.write(
      "home/.pi/agent/mcp.json",
      JSON.stringify({ mcpServers: { legacy: { type: "sse", url: "https://s.example/sse" } } }),
    );
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "pi", "backend"),
    });
    const legacy = entry(snapshot, "pi:user", "legacy");
    expect(legacy.status).toBe("unsupported");
    expect(legacy.actions.edit.supported).toBe(false);
    expect(legacy.actions.remove.supported).toBe(true);
  });
});
