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

describe("Pi catalog mirrors the bridge's loading rules", () => {
  test("a disabled higher entry is labelled disabled and the lower entry is effective", async () => {
    const targetId = await containerPiTarget(
      { mcpServers: { db: { command: "user-db" } } },
      { mcpServers: { db: { command: "project-db", disabled: true } } },
    );
    const snapshot = await fixture.service.snapshot({ targetId });
    const project = entry(snapshot, "pi:project", "db");
    const user = entry(snapshot, "pi:user", "db");
    expect(project.status).toBe("disabled");
    expect(project.statusReason).toContain("lower-priority entry");
    expect(project.shadowedBy).toBeUndefined();
    expect(user.status).toBe("effective");
    expect(snapshot.effective.db).toBe(user.entryId);
  });

  test("a disabled lower entry says the higher entry takes priority", async () => {
    const targetId = await containerPiTarget(
      { mcpServers: { db: { command: "user-db", disabled: true } } },
      { mcpServers: { db: { command: "project-db" } } },
    );
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(entry(snapshot, "pi:user", "db").status).toBe("disabled");
    expect(entry(snapshot, "pi:user", "db").statusReason).toContain("takes priority");
    expect(entry(snapshot, "pi:project", "db").status).toBe("effective");
  });

  test("normalized-name duplicates in one file are read-only conflicts; the last one is used", async () => {
    fixture.write(
      "home/.pi/agent/mcp.json",
      JSON.stringify({
        mcpServers: {
          "my server": { command: "first" },
          my_server: { command: "second" },
          other: { command: "y" },
        },
      }),
    );
    const targetId = await targetIdFor(fixture, "pi", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
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

  test("entries the bridge skips are invalid with a reason and fall through to a lower entry", async () => {
    const targetId = await containerPiTarget(
      { mcpServers: { web: { url: "https://user.example/mcp" } } },
      {
        mcpServers: {
          web: { url: "ftp://project.example/mcp" },
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
    expect(entry(snapshot, "pi:project", "noUrl").statusReason).toContain("needs a URL");
    expect(entry(snapshot, "pi:project", "noUrl").status).toBe("invalid");
    expect(entry(snapshot, "pi:project", "weird").status).not.toBe("effective");
    expect(entry(snapshot, "pi:project", "9lives").statusReason).toContain("start with a letter");
    expect(snapshot.effective.noUrl).toBeUndefined();
    expect(snapshot.effective["9lives"]).toBeUndefined();
  });

  test("servers past the bridge's per-file limit are reported as skipped", async () => {
    const servers: Record<string, unknown> = {};
    for (let index = 0; index < 66; index += 1)
      servers[`s${String(index).padStart(2, "0")}`] = { command: "x" };
    servers.s00 = { command: "x", disabled: true };
    fixture.write("home/.pi/agent/mcp.json", JSON.stringify({ mcpServers: servers }));
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "pi", "backend"),
    });
    // s00 is disabled and does not count, so s01..s64 load and s65 does not.
    expect(entry(snapshot, "pi:user", "s64").status).toBe("effective");
    expect(entry(snapshot, "pi:user", "s65").status).toBe("invalid");
    expect(entry(snapshot, "pi:user", "s65").statusReason).toContain("at most 64");
  });
});

describe("Pi adapter", () => {
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
    const { remove } = await crud(fixture, "pi", "pi:user");
    expect(Object.keys(JSON.parse(fixture.read("home/.pi/agent/mcp.json")))).toEqual([
      "mcpServers",
    ]);
    await remove();
    expect(
      JSON.parse(fixture.read("home/.pi/agent/mcp.json")).mcpServers["fixture-b"],
    ).toBeUndefined();
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
