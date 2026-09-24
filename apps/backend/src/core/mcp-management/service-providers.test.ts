import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { crud } from "./provider-test-support.js";
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

describe("provider adapters", () => {
  test("Codex: TOML CRUD keeps comments, other tables and advanced fields", async () => {
    fixture.write(
      "home/.codex/config.toml",
      `# my codex settings\nmodel = "o3"\n\n[mcp_servers.existing]\ncommand = "keep"\nstartup_timeout_sec = 20.0\ntool_timeout_sec = 60\nenv_vars = ["PATH"]\n\n[profiles.p]\nmodel = "x"\n`,
    );
    const { remove, snapshot } = await crud(fixture, "codex", "codex:user");
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

  test("Codex: the bearer variable must be a plain name and never Orkestrator's own token", async () => {
    const targetId = await targetIdFor(fixture, "codex", "backend");
    const add = (name: string, bearer: string) =>
      fixture.service.mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "codex:user",
          expectedRevision: null,
          definition: {
            name,
            transport: "http",
            url: "https://example.com/mcp",
            advanced: { bearer_token_env_var: bearer },
          },
        }),
      );
    await expect(add("leak", "ORKESTRATOR_AGENT_MCP_TOKEN")).rejects.toThrow(
      "Orkestrator's own credentials",
    );
    await expect(add("leak", "CODEX_BRIDGE_TOKEN")).rejects.toThrow(
      "Orkestrator's own credentials",
    );
    await expect(add("shaped", "${MY_TOKEN}")).rejects.toThrow("Name an environment variable");
    await add("ok", "MY_SERVICE_TOKEN");
    const parsed = Bun.TOML.parse(fixture.read("home/.codex/config.toml")) as any;
    expect(parsed.mcp_servers.ok.bearer_token_env_var).toBe("MY_SERVICE_TOKEN");
    expect(parsed.mcp_servers.leak).toBeUndefined();
    // An update cannot introduce it either.
    const snapshot = await fixture.service.snapshot({ targetId });
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "update",
          entryId: entry(snapshot, "codex:user", "ok").entryId,
          expectedRevision: revision(snapshot, "codex:user")!,
          patch: { advanced: { set: { bearer_token_env_var: "ORKESTRATOR_AGENT_MCP_TOKEN" } } },
        }),
      ),
    ).rejects.toThrow("Orkestrator's own credentials");
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
    const { remove, snapshot } = await crud(fixture, "opencode", "opencode:user-opencode.jsonc");
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
    const { remove } = await crud(fixture, "cursor", "cursor:user", { kind: "environment" });
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
    await remove();
    expect(
      JSON.parse(fixture.read("home/.cursor/mcp.json")).mcpServers["fixture-b"],
    ).toBeUndefined();
  });

  test("Cursor: unknown fields and neighbouring servers survive an edit", async () => {
    fixture.write(
      "home/.cursor/mcp.json",
      JSON.stringify(
        {
          mcpServers: {
            kept: { command: "x", auth: { CLIENT_ID: "abc" }, envFile: ".env.mcp" },
            other: { url: "https://o.example/mcp", headers: { A: "${A}" } },
          },
          extraTopLevel: { keep: true },
        },
        null,
        2,
      ),
    );
    const targetId = await targetIdFor(fixture, "cursor", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(entry(snapshot, "cursor:user", "kept").preservedFields).toEqual(["auth", "envFile"]);
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "update",
        entryId: entry(snapshot, "cursor:user", "kept").entryId,
        expectedRevision: revision(snapshot, "cursor:user")!,
        patch: { args: [{ kind: "set", value: "--new" }] },
      }),
    );
    const parsed = JSON.parse(fixture.read("home/.cursor/mcp.json"));
    expect(parsed.mcpServers.kept).toEqual({
      command: "x",
      args: ["--new"],
      auth: { CLIENT_ID: "abc" },
      envFile: ".env.mcp",
    });
    expect(parsed.mcpServers.other).toEqual({
      url: "https://o.example/mcp",
      headers: { A: "${A}" },
    });
    expect(parsed.extraTopLevel).toEqual({ keep: true });
  });

  test("Cursor: provider limits are the protocol's, not wider", async () => {
    const targetId = await targetIdFor(fixture, "cursor", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    fixture.write(
      "home/.cursor/mcp.json",
      JSON.stringify({ mcpServers: { wide: { command: "x" } } }),
    );
    const fresh = await fixture.service.snapshot({ targetId });
    expect(snapshot.target.capabilities.nameRule.maxBytes).toBeGreaterThan(0);
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "update",
          entryId: entry(fresh, "cursor:user", "wide").entryId,
          expectedRevision: revision(fresh, "cursor:user")!,
          patch: {
            env: Array.from({ length: 65 }, (_, index) => ({
              key: `K${index}`,
              edit: { kind: "set" as const, value: "${V}" },
            })),
          },
        }),
      ),
    ).rejects.toThrow(/64/);
  });

  test("OpenCode: XDG_CONFIG_HOME relocates the user file", async () => {
    const custom = mkdtempSync(path.join(tmpdir(), "mcp-xdg-"));
    fixture.cleanup();
    fixture = createFixture({ env: { XDG_CONFIG_HOME: custom } });
    const read = () =>
      JSON.parse(readFileSync(path.join(custom, "opencode", "opencode.json"), "utf8"));
    const { remove } = await crud(fixture, "opencode", "opencode:user-opencode.json");
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "opencode", "backend"),
    });
    expect(
      snapshot.sources.find((source) => source.sourceId === "opencode:user-opencode.json")
        ?.displayPath,
    ).toBe(`${custom}/opencode/opencode.json`);
    expect(read().mcp["fixture-b"].type).toBe("local");
    await remove();
    expect(read().mcp?.["fixture-b"]).toBeUndefined();
    rmSync(custom, { recursive: true, force: true });
  });
});
