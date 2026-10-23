import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { crud } from "./provider-test-support.js";
import {
  createFixture,
  entry,
  mutation,
  revision,
  targetIdFor,
  type Fixture,
} from "./test-support.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ env: {} });
});

afterEach(() => {
  fixture.cleanup();
});

/** A container target sees both the user and the project file as loaded sources. */
async function containerPiTarget(user: unknown, project: unknown): Promise<string> {
  fixture.environment.environmentType = "containerized";
  fixture.environment.containerId = "container-1";
  fixture.containerFiles.set("/home/node/.pi/agent/mcp.json", JSON.stringify(user));
  fixture.containerFiles.set("/workspace/.pi/mcp.json", JSON.stringify(project));
  return targetIdFor(fixture, "pi", "environment");
}

async function hostPiSnapshot(user: unknown) {
  fixture.write("home/.pi/agent/mcp.json", JSON.stringify(user, null, 2));
  const targetId = await targetIdFor(fixture, "pi", "backend");
  return { targetId, snapshot: await fixture.service.snapshot({ targetId }) };
}

describe("Pi catalog mirrors the bridge's loading rules", () => {
  test("disabling a project replacement keeps the user entry shadowed", async () => {
    const targetId = await containerPiTarget(
      { mcpServers: { db: { command: "user-db" } } },
      { mcpServers: { db: { command: "project-db" } } },
    );
    const before = await fixture.service.snapshot({ targetId });
    const project = entry(before, "pi:project", "db");
    expect(project.status).toBe("effective");
    expect(entry(before, "pi:user", "db").status).toBe("shadowed");

    // Container files are read-only in the editor; Pi's native manager can
    // save this switch, which the next catalogue read must reconcile.
    fixture.containerFiles.set(
      "/workspace/.pi/mcp.json",
      JSON.stringify({ mcpServers: { db: { command: "project-db", enabled: false } } }),
    );
    const after = await fixture.service.snapshot({ targetId });
    expect(entry(after, "pi:project", "db").status).toBe("disabled");
    expect(entry(after, "pi:user", "db").status).toBe("shadowed");
    expect(entry(after, "pi:user", "db").shadowedBy).toBe(project.entryId);
    expect(after.effective.db).toBe(project.entryId);
  });

  test("a disabled project server replaces the user server, so neither runs", async () => {
    const targetId = await containerPiTarget(
      { mcpServers: { db: { command: "user-db" }, api: { command: "user-api" } } },
      {
        mcpServers: {
          db: { command: "project-db", disabled: true },
          api: { command: "project-api", enabled: false },
        },
      },
    );
    const snapshot = await fixture.service.snapshot({ targetId });
    for (const name of ["db", "api"]) {
      const project = entry(snapshot, "pi:project", name);
      const user = entry(snapshot, "pi:user", name);
      expect(project.status).toBe("disabled");
      expect(project.enabled).toBe(false);
      expect(user.status).toBe("shadowed");
      expect(user.shadowedBy).toBe(project.entryId);
      expect(user.statusReason).toContain("even when it is disabled");
      expect(snapshot.effective[name]).toBe(project.entryId);
    }
  });

  test("a disabled user server is replaced by the project server", async () => {
    const targetId = await containerPiTarget(
      { mcpServers: { db: { command: "user-db", enabled: false } } },
      { mcpServers: { db: { command: "project-db" } } },
    );
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(entry(snapshot, "pi:user", "db").status).toBe("shadowed");
    expect(entry(snapshot, "pi:project", "db").status).toBe("effective");
  });

  test("a project override switches the user server and is not a server itself", async () => {
    const targetId = await containerPiTarget(
      {
        mcpServers: {
          off: { command: "a" },
          on: { command: "b", enabled: false },
          exposed: { command: "c" },
          extra: { command: "d" },
        },
      },
      {
        mcpServers: {
          off: { enabled: false },
          on: { enabled: true },
          exposed: { toolExposure: { "*": "hidden" } },
          extra: { enabled: false, args: ["x"] },
          orphan: { enabled: true },
        },
      },
    );
    const snapshot = await fixture.service.snapshot({ targetId });
    const userOff = entry(snapshot, "pi:user", "off");
    expect(userOff.status).toBe("disabled");
    expect(userOff.statusReason).toContain("Turned off in this project by the override");
    const overrideOff = entry(snapshot, "pi:project", "off");
    expect(overrideOff.status).toBe("disabled");
    expect(overrideOff.statusReason).toContain('turns "off" in');
    expect(overrideOff.shadowedBy).toBeUndefined();
    // The user entry still defines the server; the override only switches it.
    expect(snapshot.effective.off).toBe(userOff.entryId);

    expect(entry(snapshot, "pi:user", "on").status).toBe("effective");
    expect(entry(snapshot, "pi:user", "on").statusReason).toContain("Turned on in this project");
    expect(entry(snapshot, "pi:project", "on").status).toBe("effective");
    expect(entry(snapshot, "pi:user", "exposed").status).toBe("effective");
    expect(entry(snapshot, "pi:project", "exposed").statusReason).toContain("how Pi exposes");

    expect(entry(snapshot, "pi:project", "extra").status).toBe("invalid");
    expect(entry(snapshot, "pi:project", "extra").statusReason).toContain(
      "can set only enabled, exposure and toolExposure",
    );
    expect(entry(snapshot, "pi:user", "extra").status).toBe("effective");
    expect(entry(snapshot, "pi:project", "orphan").status).toBe("invalid");
    expect(entry(snapshot, "pi:project", "orphan").statusReason).toContain(
      'no user server is named "orphan"',
    );
  });

  test("a Pi project override is not editable as a server, but can be removed", async () => {
    // A local environment's project file is writable even though host Pi
    // sessions exclude it.
    fixture.write(
      "worktree/.pi/mcp.json",
      JSON.stringify({ mcpServers: { db: { enabled: false } } }),
    );
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "pi", "environment"),
    });
    const override = entry(snapshot, "pi:project", "db");
    expect(override.status).toBe("policy-excluded");
    expect(override.actions.edit.reason).toContain("only overrides the user server");
    expect(override.actions.setEnabled.supported).toBe(false);
    expect(override.actions.remove.supported).toBe(true);
  });

  test("names that differ only in '-' and '_' are one Pi server; the later one is rejected", async () => {
    const targetId = await containerPiTarget(
      { mcpServers: { "foo-bar": { command: "a" }, foo_bar: { command: "b" } } },
      { mcpServers: { "x-y": { command: "c" } } },
    );
    let snapshot = await fixture.service.snapshot({ targetId });
    const kept = entry(snapshot, "pi:user", "foo-bar");
    const dropped = entry(snapshot, "pi:user", "foo_bar");
    expect(kept.status).toBe("effective");
    expect(dropped.status).toBe("invalid");
    expect(dropped.statusReason).toContain('keeps "foo-bar", which it reads first');
    expect(snapshot.effective.foo_bar).toBeUndefined();
    expect(entry(snapshot, "pi:project", "x-y").status).toBe("effective");

    fixture.containerFiles.set(
      "/workspace/.pi/mcp.json",
      JSON.stringify({ mcpServers: { foo_bar: { command: "c" } } }),
    );
    snapshot = await fixture.service.snapshot({ targetId });
    expect(entry(snapshot, "pi:project", "foo_bar").status).toBe("invalid");
    expect(entry(snapshot, "pi:project", "foo_bar").statusReason).toContain(
      '"foo-bar" in This environment',
    );
  });

  test("auth: a user server is kept but not started; a project server is rejected", async () => {
    const targetId = await containerPiTarget(
      {
        mcpServers: {
          gh: { url: "https://gh.example/mcp", auth: { provider: "github" } },
          shared: { command: "user-shared" },
          local: { command: "x", auth: { provider: "github" } },
        },
      },
      {
        mcpServers: {
          shared: { url: "https://p.example/mcp", auth: { provider: "github" } },
        },
      },
    );
    const snapshot = await fixture.service.snapshot({ targetId });
    const gh = entry(snapshot, "pi:user", "gh");
    expect(gh.status).toBe("invalid");
    expect(gh.statusReason).toContain("signs in with a Pi provider");
    // It is still the server Pi uses for that name, so it still hides others.
    expect(snapshot.effective.gh).toBe(gh.entryId);
    // `auth` means nothing to a local server.
    expect(entry(snapshot, "pi:user", "local").status).toBe("effective");
    const project = entry(snapshot, "pi:project", "shared");
    expect(project.status).toBe("invalid");
    expect(project.statusReason).toContain("cannot use auth");
    expect(project.statusReason).toContain("lower-priority entry");
    expect(entry(snapshot, "pi:user", "shared").status).toBe("effective");
  });

  test("values the bridge can never resolve stop the server but still shadow", async () => {
    const targetId = await containerPiTarget(
      {
        mcpServers: {
          shell: { url: "https://a.example/mcp", headers: { A: "!gh auth token" } },
          secret: { command: "x", env: { K: "Bearer ${ORKESTRATOR_AGENT_MCP_TOKEN}" } },
          plain: { command: "x", env: { K: "${SOME_TOKEN}", L: "$$5" } },
          blank: { command: "  " },
          shadow: { command: "user" },
        },
      },
      { mcpServers: { shadow: { command: "project", env: { K: "!cat key" } } } },
    );
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(entry(snapshot, "pi:user", "shell").statusReason).toContain("`!command`");
    expect(entry(snapshot, "pi:user", "secret").statusReason).toContain(
      "ORKESTRATOR_AGENT_MCP_TOKEN",
    );
    expect(entry(snapshot, "pi:user", "blank").statusReason).toContain("command is empty");
    // A variable may be set in the bridge's environment; the backend cannot tell.
    expect(entry(snapshot, "pi:user", "plain").status).toBe("effective");
    expect(entry(snapshot, "pi:project", "shadow").status).toBe("invalid");
    expect(entry(snapshot, "pi:user", "shadow").status).toBe("shadowed");
  });

  test("normalized-name duplicates in one file are read-only conflicts; the last one is used", async () => {
    const { targetId, snapshot } = await hostPiSnapshot({
      mcpServers: {
        "my server": { command: "first" },
        my_server: { command: "second" },
        other: { command: "y" },
      },
    });
    const first = entry(snapshot, "pi:user", "my server");
    const second = entry(snapshot, "pi:user", "my_server");
    for (const row of [first, second]) {
      expect(row.status).toBe("invalid");
      expect(row.statusReason).toContain('same server "my_server"');
      expect(row.actions.edit.supported).toBe(false);
      expect(row.actions.rename.supported).toBe(false);
      expect(row.actions.setEnabled.supported).toBe(false);
      expect(row.actions.remove.supported).toBe(true);
      expect(row.shadowedBy).toBeUndefined();
    }
    expect(second.statusReason).toContain("this is the one Pi uses");
    expect(first.statusReason).toContain('Pi uses "my_server"');
    // Matches the bridge's Map.set: the later entry is the one loaded.
    expect(snapshot.effective.my_server).toBe(second.entryId);
    expect(entry(snapshot, "pi:user", "other").status).toBe("effective");
    // Editing is refused by the service, not only hidden by the UI.
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "update",
          entryId: second.entryId,
          expectedRevision: revision(snapshot, "pi:user")!,
          patch: { command: { kind: "set", value: "third" } },
        }),
      ),
    ).rejects.toThrow("Remove the duplicates");
    // Removing one duplicate is the repair, and it resolves the conflict.
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "remove",
        entryId: first.entryId,
        expectedRevision: revision(snapshot, "pi:user")!,
      }),
    );
    const repaired = await fixture.service.snapshot({ targetId });
    expect(entry(repaired, "pi:user", "my_server").status).toBe("effective");
  });

  test("entries Pi rejects are invalid with a reason and hide nothing", async () => {
    const targetId = await containerPiTarget(
      { mcpServers: { web: { url: "https://user.example/mcp" }, tool: { command: "t" } } },
      {
        mcpServers: {
          web: { url: "ftp://project.example/mcp" },
          tool: { command: "p", enabled: "no" },
          noUrl: { transport: "http", command: "x" },
          weird: { transport: "websocket", url: "https://w.example" },
          "9lives": { command: "x" },
        },
      },
    );
    const snapshot = await fixture.service.snapshot({ targetId });
    const project = entry(snapshot, "pi:project", "web");
    expect(project.status).toBe("invalid");
    expect(project.statusReason).toContain("http:// or https://");
    expect(project.statusReason).toContain("lower-priority entry");
    const user = entry(snapshot, "pi:user", "web");
    expect(user.status).toBe("effective");
    expect(snapshot.effective.web).toBe(user.entryId);
    expect(entry(snapshot, "pi:project", "tool").statusReason).toContain("true or false");
    expect(entry(snapshot, "pi:user", "tool").status).toBe("effective");
    expect(entry(snapshot, "pi:project", "noUrl").statusReason).toContain("needs a URL");
    expect(entry(snapshot, "pi:project", "noUrl").status).toBe("invalid");
    expect(entry(snapshot, "pi:project", "weird").statusReason).toContain("not recognised");
    expect(entry(snapshot, "pi:project", "9lives").statusReason).toContain("start with a letter");
    expect(snapshot.effective.noUrl).toBeUndefined();
    expect(snapshot.effective["9lives"]).toBeUndefined();
  });

  test("the per-file limit counts disabled entries; the session keeps a slot for Orkestrator", async () => {
    const servers: Record<string, unknown> = {};
    for (let index = 0; index < 66; index += 1)
      servers[`s${String(index).padStart(2, "0")}`] = { command: "x" };
    servers.s00 = { command: "x", enabled: false };
    let { snapshot } = await hostPiSnapshot({ mcpServers: servers });
    // s00..s63 are read; s01..s63 are the 63 servers that fit beside Orkestrator's.
    expect(entry(snapshot, "pi:user", "s00").status).toBe("disabled");
    expect(entry(snapshot, "pi:user", "s63").status).toBe("effective");
    expect(entry(snapshot, "pi:user", "s64").status).toBe("invalid");
    expect(entry(snapshot, "pi:user", "s64").statusReason).toContain(
      "at most 64 entries from one file, counting disabled entries",
    );

    servers.s00 = { command: "x" };
    ({ snapshot } = await hostPiSnapshot({ mcpServers: servers }));
    expect(entry(snapshot, "pi:user", "s62").status).toBe("effective");
    expect(entry(snapshot, "pi:user", "s63").status).toBe("invalid");
    expect(entry(snapshot, "pi:user", "s63").statusReason).toContain("at most 63 servers");
  });
});

describe("Pi adapter", () => {
  test("Pi: disabling an entry reveals no fallback in the preview or saved catalogue", async () => {
    const { targetId, snapshot } = await hostPiSnapshot({
      mcpServers: { "foo-bar": { command: "a" }, foo_bar: { command: "b" } },
    });
    const winner = entry(snapshot, "pi:user", "foo-bar");
    const request = mutation(targetId, {
      kind: "set-enabled",
      entryId: winner.entryId,
      expectedRevision: revision(snapshot, "pi:user")!,
      enabled: false,
    });
    const validation = await fixture.service.validate(request);
    expect(validation.valid).toBe(true);
    expect(validation.preview).not.toBeNull();
    expect(validation.preview?.revealsEntryId).toBeUndefined();
    await fixture.service.mutate(request);
    const after = await fixture.service.snapshot({ targetId });
    expect(entry(after, "pi:user", "foo-bar").status).toBe("disabled");
    expect(after.effective["foo-bar"]).toBe(winner.entryId);
    expect(entry(after, "pi:user", "foo_bar").status).toBe("invalid");
    expect(after.effective.foo_bar).toBeUndefined();
  });

  test("Pi: the editor writes enabled: false, clears either spelling, and migrates disabled", async () => {
    let { targetId, snapshot } = await hostPiSnapshot({
      mcpServers: {
        pi: { command: "a", enabled: false },
        legacy: { command: "b", disabled: true, enabled: false },
        claude: { command: "c", disabled: true },
        on: { command: "d" },
      },
    });
    expect(entry(snapshot, "pi:user", "pi").status).toBe("disabled");
    expect(entry(snapshot, "pi:user", "pi").enabled).toBe(false);
    expect(entry(snapshot, "pi:user", "claude").status).toBe("disabled");
    const setEnabled = async (name: string, enabled: boolean) => {
      snapshot = await fixture.service.snapshot({ targetId });
      await fixture.service.mutate(
        mutation(targetId, {
          kind: "set-enabled",
          entryId: entry(snapshot, "pi:user", name).entryId,
          expectedRevision: revision(snapshot, "pi:user")!,
          enabled,
        }),
      );
    };
    await setEnabled("pi", true);
    await setEnabled("legacy", true);
    await setEnabled("on", false);
    // An edit to a `disabled: true` entry rewrites it in Pi's spelling.
    snapshot = await fixture.service.snapshot({ targetId });
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "update",
        entryId: entry(snapshot, "pi:user", "claude").entryId,
        expectedRevision: revision(snapshot, "pi:user")!,
        patch: { command: { kind: "set", value: "c2" } },
      }),
    );
    expect(JSON.parse(fixture.read("home/.pi/agent/mcp.json")).mcpServers).toEqual({
      pi: { command: "a" },
      legacy: { command: "b" },
      claude: { command: "c2", enabled: false },
      on: { command: "d", enabled: false },
    });
    snapshot = await fixture.service.snapshot({ targetId });
    expect(entry(snapshot, "pi:user", "pi").status).toBe("effective");
    expect(entry(snapshot, "pi:user", "on").status).toBe("disabled");
  });

  test("Pi: bare maps are edited in place and labelled; names Pi merges are refused", async () => {
    let { targetId, snapshot } = await hostPiSnapshot({
      "my-server": { command: "x", disabled: true, extra: 1 },
    });
    const disabled = entry(snapshot, "pi:user", "my-server");
    expect(disabled.status).toBe("disabled");
    expect(disabled.enabled).toBe(false);
    expect(disabled.preservedFields).toEqual(["extra"]);
    expect(snapshot.sources.find((source) => source.sourceId === "pi:user")?.note).toContain(
      "without the mcpServers wrapper",
    );
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
    // Pi reads "my_server" as the same server as "my-server" and would drop it.
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "pi:user",
          expectedRevision: revision(snapshot, "pi:user"),
          definition: { name: "my_server", transport: "stdio", command: "x" },
        }),
      ),
    ).rejects.toThrow('Pi treats this name the same as "my-server"');
    // "my server" is loaded by Pi as "my_server", so that name is taken.
    ({ snapshot } = await hostPiSnapshot({
      "my server": { command: "x" },
      other: { command: "y" },
    }));
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
      other: { command: "y", enabled: false },
    });
  });

  test("Pi: removing the first of a '-'/'_' pair reveals the one Pi had rejected", async () => {
    const { targetId, snapshot } = await hostPiSnapshot({
      mcpServers: { "foo-bar": { command: "a" }, foo_bar: { command: "b" } },
    });
    const result = await fixture.service.validate(
      mutation(targetId, {
        kind: "remove",
        entryId: entry(snapshot, "pi:user", "foo-bar").entryId,
        expectedRevision: revision(snapshot, "pi:user")!,
      }),
    );
    expect(result.preview?.revealsEntryId).toBe(entry(snapshot, "pi:user", "foo_bar").entryId);
  });

  test("Pi: a local server's working directory is editable", async () => {
    const targetId = await targetIdFor(fixture, "pi", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(snapshot.target.capabilities.fields.cwd.supported).toBe(true);
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId: "pi:user",
        expectedRevision: null,
        definition: { name: "work", transport: "stdio", command: "x", cwd: "~/work" },
      }),
    );
    expect(JSON.parse(fixture.read("home/.pi/agent/mcp.json")).mcpServers.work).toEqual({
      command: "x",
      cwd: "~/work",
    });
    const after = await fixture.service.snapshot({ targetId });
    expect(entry(after, "pi:user", "work").preservedFields).toEqual([]);
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
    const { remove } = await crud(fixture, "pi", "pi:user");
    expect(Object.keys(JSON.parse(fixture.read("home/.pi/agent/mcp.json")))).toEqual([
      "mcpServers",
    ]);
    await remove();
    expect(
      JSON.parse(fixture.read("home/.pi/agent/mcp.json")).mcpServers["fixture-b"],
    ).toBeUndefined();
  });

  test("Pi: an SSE-declared entry runs over Streamable HTTP, is not editable, and is removable", async () => {
    const { snapshot } = await hostPiSnapshot({
      mcpServers: { legacy: { type: "sse", url: "https://s.example/sse" } },
    });
    const legacy = entry(snapshot, "pi:user", "legacy");
    expect(legacy.status).toBe("effective");
    expect(legacy.statusReason).toContain("Streamable HTTP");
    expect(legacy.actions.edit.supported).toBe(false);
    expect(legacy.actions.remove.supported).toBe(true);
  });

  test("Pi: terminals read these files with Pi's own MCP client", async () => {
    const targetId = await targetIdFor(fixture, "pi", "backend");
    const { target } = await fixture.service.snapshot({ targetId });
    expect(target.capabilities.terminal.readsNativeConfig).toBe(true);
    expect(target.capabilities.terminal.guidance).toContain("enabled: false");
    expect(target.capabilities.authentication.runtimeSignIn.reason).toContain("/mcp login");
  });

  test("Pi: PI_CODING_AGENT_DIR relocates the user file", async () => {
    const custom = mkdtempSync(path.join(tmpdir(), "mcp-pi-dir-"));
    fixture.cleanup();
    fixture = createFixture({ env: { PI_CODING_AGENT_DIR: custom } });
    const { remove } = await crud(fixture, "pi", "pi:user");
    const file = path.join(custom, "mcp.json");
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers["fixture-b"].command).toBe(
      "/opt/My Tools/server",
    );
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "pi", "backend"),
    });
    expect(snapshot.sources.find((row) => row.sourceId === "pi:user")?.displayPath).toBe(file);
    await remove();
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers["fixture-b"]).toBeUndefined();
    rmSync(custom, { recursive: true, force: true });
  });
});
