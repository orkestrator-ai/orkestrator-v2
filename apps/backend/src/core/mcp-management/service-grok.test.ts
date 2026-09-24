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

async function grokSnapshot(kind: "backend" | "environment" = "environment") {
  return fixture.service.snapshot({ targetId: await targetIdFor(fixture, "grok", kind) });
}

function source(snapshot: Awaited<ReturnType<typeof grokSnapshot>>, sourceId: string) {
  const found = snapshot.sources.find((candidate) => candidate.sourceId === sourceId);
  if (!found) throw new Error(`no source ${sourceId}`);
  return found;
}

describe("Grok adapter", () => {
  test("Grok: native TOML CRUD, compatibility sources read-only and below native", async () => {
    fixture.write(
      "home/.claude.json",
      JSON.stringify({ mcpServers: { shared: { command: "claude-one" } } }),
    );
    fixture.write("home/.grok/config.toml", `[mcp_servers.shared]\ncommand = "grok-one"\n`);
    const { remove } = await crud(fixture, "grok", "grok:user", { kind: "environment" });
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
    await remove();
    expect(
      (Bun.TOML.parse(fixture.read("home/.grok/config.toml")) as any).mcp_servers["fixture-b"],
    ).toBeUndefined();
  });

  test("Grok: [compat] mcps = false marks imported sources excluded", async () => {
    fixture.write("home/.claude.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    fixture.write("home/.grok/config.toml", `[compat.claude]\nmcps = false\n`);
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "grok", "backend"),
    });
    expect(entry(snapshot, "grok:compat-claude-user", "a").status).toBe("policy-excluded");
  });

  test("Grok: enabled = false is shown as disabled and the switch stays gated", async () => {
    fixture.write(
      "home/.grok/config.toml",
      `[mcp_servers.off]\ncommand = "x"\nenabled = false\n\n[mcp_servers.on]\ncommand = "y"\n`,
    );
    const snapshot = await grokSnapshot("backend");
    const off = entry(snapshot, "grok:user", "off");
    expect(off.status).toBe("disabled");
    expect(off.enabled).toBe(false);
    expect(off.preservedFields).toEqual([]);
    expect(off.actions.setEnabled.supported).toBe(false);
    expect(entry(snapshot, "grok:user", "on")).toMatchObject({
      status: "effective",
      enabled: true,
    });
    // An unrelated edit keeps the saved switch exactly as it was.
    await fixture.service.mutate(
      mutation(snapshot.target.targetId, {
        kind: "update",
        entryId: off.entryId,
        expectedRevision: revision(snapshot, "grok:user")!,
        patch: { args: [{ kind: "set", value: "--a" }] },
      }),
    );
    const parsed = Bun.TOML.parse(fixture.read("home/.grok/config.toml")) as any;
    expect(parsed.mcp_servers.off).toEqual({ command: "x", args: ["--a"], enabled: false });
  });

  test("Grok: disabled_mcp_servers disables a server wherever it is defined", async () => {
    fixture.write(
      "home/.claude.json",
      JSON.stringify({ mcpServers: { imported: { command: "c" } } }),
    );
    fixture.write(
      "home/.grok/config.toml",
      `disabled_mcp_servers = ["imported", "native"]\n\n[mcp_servers.native]\ncommand = "n"\n`,
    );
    const snapshot = await grokSnapshot("backend");
    for (const row of [
      entry(snapshot, "grok:user", "native"),
      entry(snapshot, "grok:compat-claude-user", "imported"),
    ]) {
      expect(row.status).toBe("disabled");
      expect(row.statusReason).toContain("disabled_mcp_servers");
      expect(row.enabled).toBe(false);
    }
    expect(snapshot.effective.native).toBeUndefined();
  });

  test("Grok: unknown fields survive an edit", async () => {
    fixture.write(
      "home/.grok/config.toml",
      `# keep me\n[mcp_servers.kept]\ncommand = "x"\ncwd = "/srv"\nsetup = "make"\ntool_timeouts = { search = 30 }\n\n[mcp_servers.kept.oauth]\nclient_id = "abc"\n`,
    );
    const snapshot = await grokSnapshot("backend");
    const kept = entry(snapshot, "grok:user", "kept");
    expect(kept.preservedFields.sort()).toEqual(["cwd", "oauth", "setup", "tool_timeouts"]);
    await fixture.service.mutate(
      mutation(snapshot.target.targetId, {
        kind: "update",
        entryId: kept.entryId,
        expectedRevision: revision(snapshot, "grok:user")!,
        patch: { command: { kind: "set", value: "y" } },
      }),
    );
    const text = fixture.read("home/.grok/config.toml");
    expect(text).toContain("# keep me");
    expect((Bun.TOML.parse(text) as any).mcp_servers.kept).toEqual({
      command: "y",
      cwd: "/srv",
      setup: "make",
      tool_timeouts: { search: 30 },
      oauth: { client_id: "abc" },
    });
  });

  test("Grok: GROK_HOME relocates the native file and the compat switches", async () => {
    const custom = mkdtempSync(path.join(tmpdir(), "mcp-grok-home-"));
    fixture.cleanup();
    fixture = createFixture({ env: { GROK_HOME: custom } });
    fixture.write("home/.claude.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    // The default home's switch no longer applies; the relocated one does.
    fixture.write("home/.grok/config.toml", `[compat.claude]\nmcps = true\n`);
    const { remove } = await crud(fixture, "grok", "grok:user");
    const file = path.join(custom, "config.toml");
    expect(
      (Bun.TOML.parse(readFileSync(file, "utf8")) as any).mcp_servers["fixture-b"],
    ).toBeTruthy();
    let snapshot = await grokSnapshot("backend");
    expect(source(snapshot, "grok:user").displayPath).toBe(file);
    await remove();
    const text = readFileSync(file, "utf8");
    Bun.write(file, `${text}\n[compat.claude]\nmcps = false\n`);
    await Bun.sleep(1);
    snapshot = await grokSnapshot("backend");
    expect(entry(snapshot, "grok:compat-claude-user", "a").status).toBe("policy-excluded");
    rmSync(custom, { recursive: true, force: true });
  });

  test("Grok: compat switches come from the user scope and the environment, not the project", async () => {
    fixture.write("home/.claude.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    fixture.write("worktree/.grok/config.toml", `[compat.claude]\nmcps = false\n`);
    let snapshot = await grokSnapshot();
    expect(entry(snapshot, "grok:compat-claude-user", "a").status).toBe("effective");

    fixture.write("home/.grok/config.toml", `[compat.claude]\nmcps = false\n`);
    snapshot = await grokSnapshot();
    expect(entry(snapshot, "grok:compat-claude-user", "a").statusReason).toContain(
      "[compat.claude]",
    );

    // The documented environment variable wins over config.toml, both ways.
    fixture.cleanup();
    fixture = createFixture({ env: { GROK_CLAUDE_MCPS_ENABLED: "1" } });
    fixture.write("home/.claude.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    fixture.write("home/.grok/config.toml", `[compat.claude]\nmcps = false\n`);
    snapshot = await grokSnapshot();
    expect(entry(snapshot, "grok:compat-claude-user", "a").status).toBe("effective");

    fixture.cleanup();
    fixture = createFixture({ env: { GROK_CURSOR_MCPS_ENABLED: "false" } });
    fixture.write("home/.cursor/mcp.json", JSON.stringify({ mcpServers: { c: { command: "x" } } }));
    snapshot = await grokSnapshot();
    const cursor = entry(snapshot, "grok:compat-cursor-user", "c");
    expect(cursor.status).toBe("policy-excluded");
    expect(cursor.statusReason).toContain("GROK_CURSOR_MCPS_ENABLED");
  });

  test("Grok: compatibility sources follow Grok's documented priority", async () => {
    fixture.write(".mcp-placeholder", "");
    fixture.write(
      "worktree/.mcp.json",
      JSON.stringify({ mcpServers: { s: { command: "mcp-json" } } }),
    );
    fixture.write(
      "home/.cursor/mcp.json",
      JSON.stringify({ mcpServers: { s: { command: "cursor" } } }),
    );
    fixture.write(
      "home/.claude.json",
      JSON.stringify({ mcpServers: { s: { command: "claude" } } }),
    );
    let snapshot = await grokSnapshot();
    expect(snapshot.effective.s).toBe(entry(snapshot, "grok:compat-claude-user", "s").entryId);
    expect(entry(snapshot, "grok:compat-project-mcp-json", "s").status).toBe("shadowed");
    // `.mcp.json` is not governed by [compat.claude].
    fixture.write("home/.grok/config.toml", `[compat.claude]\nmcps = false\n`);
    snapshot = await grokSnapshot();
    expect(snapshot.effective.s).toBe(entry(snapshot, "grok:compat-cursor-user", "s").entryId);
    expect(entry(snapshot, "grok:compat-project-mcp-json", "s").status).toBe("shadowed");
    // The Cursor user file is one Grok reads, so Cursor says so.
    const cursorSnapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "cursor", "backend"),
    });
    expect(source(cursorSnapshot, "cursor:user").sharedWith).toEqual(["grok"]);
  });

  test("Grok: folder trust labels the project and excludes a declined folder", async () => {
    let snapshot = await grokSnapshot();
    expect(source(snapshot, "grok:project").trust).toBe("unknown");

    fixture.write(
      "home/.grok/trusted_folders.toml",
      `[folders."${fixture.worktree}"]\ntrusted = true\ndecided_at = "2026-09-01T00:00:00Z"\n`,
    );
    snapshot = await grokSnapshot();
    expect(source(snapshot, "grok:project").trust).toBe("allowed");

    fixture.write(
      "home/.grok/trusted_folders.toml",
      `[folders."${fixture.worktree}"]\ntrusted = false\n`,
    );
    fixture.write("worktree/.grok/config.toml", `[mcp_servers.p]\ncommand = "x"\n`);
    snapshot = await grokSnapshot();
    expect(source(snapshot, "grok:project").trust).toBe("excluded");
    expect(entry(snapshot, "grok:project", "p").status).toBe("policy-excluded");

    // A grant on a parent folder covers the worktree.
    fixture.write(
      "home/.grok/trusted_folders.toml",
      `[folders."${fixture.root}"]\ntrusted = true\n`,
    );
    snapshot = await grokSnapshot();
    expect(source(snapshot, "grok:project").trust).toBe("allowed");
  });
});
