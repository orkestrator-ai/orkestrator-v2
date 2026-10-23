import { describe, expect, test } from "bun:test";

import {
  divergedNames,
  expectedEntries,
  importCurrent,
  newOverlayRecord,
  observeOverlay,
  overlayDigester,
  publicOverlayState,
  rebaseOverlay,
  recordEdit,
  rewriteServerMap,
  type OverlayRecord,
} from "./overlay.js";
import type { SourceSpec } from "./types.js";

const digest = overlayDigester(Buffer.alloc(32, 7));

function record(baseline: Record<string, Record<string, unknown>>): OverlayRecord {
  return newOverlayRecord(
    {
      environmentId: "env-1",
      provider: "codex",
      sourceId: "codex:user",
      baseline,
      bootId: "boot-1",
      now: "2026-10-23T00:00:00Z",
    },
    digest,
  );
}

const A = { command: "a" };
const A2 = { command: "a2" };
const B = { command: "b" };

describe("recording edits", () => {
  test("additions, replacements and tombstones are relative to the inherited entry", () => {
    let overlay = record({ a: A, b: B });
    overlay = recordEdit(overlay, ["new"], { a: A, b: B, new: { url: "https://n" } }, digest);
    expect(overlay.changes.new).toEqual({ kind: "set", entry: { url: "https://n" }, base: null });
    overlay = recordEdit(overlay, ["a"], { a: A2, b: B }, digest);
    expect(overlay.changes.a).toEqual({ kind: "set", entry: A2, base: digest(A) });
    overlay = recordEdit(overlay, ["b"], { a: A2 }, digest);
    expect(overlay.changes.b).toEqual({ kind: "remove", base: digest(B) });
    expect(publicOverlayState(overlay, null)).toMatchObject({
      state: "in-sync",
      added: ["new"],
      replaced: ["a"],
      removed: ["b"],
    });
  });

  test("an entry edited back to its inherited value, or an addition removed, is no change", () => {
    let overlay = record({ a: A });
    overlay = recordEdit(overlay, ["a"], { a: A2 }, digest);
    overlay = recordEdit(overlay, ["a"], { a: A }, digest);
    overlay = recordEdit(overlay, ["x"], { a: A, x: B }, digest);
    overlay = recordEdit(overlay, ["x"], { a: A }, digest);
    expect(overlay.changes).toEqual({});
  });

  test("a rename is a removal of the old name and an addition of the new one", () => {
    const overlay = recordEdit(record({ a: A }), ["a", "renamed"], { renamed: A }, digest);
    expect(overlay.changes).toEqual({
      a: { kind: "remove", base: digest(A) },
      renamed: { kind: "set", entry: A, base: null },
    });
    expect(expectedEntries(overlay)).toEqual({ renamed: A });
  });
});

describe("rebasing on a fresh inherited copy", () => {
  test("an unchanged baseline keeps every change live; tombstones hold", () => {
    let overlay = record({ a: A, b: B });
    overlay = recordEdit(overlay, ["b"], { a: A }, digest);
    overlay = recordEdit(overlay, ["x"], { a: A, x: B }, digest);
    const rebased = rebaseOverlay(overlay, { a: A, b: B }, digest);
    expect(rebased.conflicts).toEqual({});
    expect(expectedEntries(rebased)).toEqual({ a: A, x: B });
  });

  test("a tombstone outlives its server, and holds when the same entry returns", () => {
    let overlay = recordEdit(record({ b: B }), ["b"], {}, digest);
    overlay = rebaseOverlay(overlay, {}, digest);
    expect(overlay.changes.b).toEqual({ kind: "remove", base: digest(B) });
    overlay = rebaseOverlay(overlay, { b: B }, digest);
    expect(overlay.conflicts).toEqual({});
    expect(expectedEntries(overlay)).toEqual({});
  });

  test("a changed or removed inherited entry under a change becomes a held conflict", () => {
    let overlay = record({ a: A, b: B });
    overlay = recordEdit(overlay, ["a"], { a: { command: "mine" }, b: B }, digest);
    overlay = recordEdit(overlay, ["b"], { a: { command: "mine" } }, digest);
    const rebased = rebaseOverlay(overlay, { a: A2, b: { command: "b2" } }, digest);
    expect(Object.keys(rebased.conflicts).sort()).toEqual(["a", "b"]);
    expect(rebased.conflicts.a).toContain("changed after this environment replaced it");
    expect(rebased.conflicts.b).toContain("changed after this environment removed it");
    // Held, not dropped; the names show the inherited value until the user decides.
    expect(rebased.changes.a).toMatchObject({ kind: "set" });
    expect(expectedEntries(rebased)).toEqual({ a: A2, b: { command: "b2" } });
    const gone = rebaseOverlay(overlay, { b: B }, digest);
    expect(gone.conflicts.a).toContain("was removed after this environment replaced it");
  });

  test("an addition the inherited copy now defines differently conflicts; identical is redundant", () => {
    const overlay = recordEdit(record({}), ["x"], { x: A }, digest);
    expect(rebaseOverlay(overlay, { x: B }, digest).conflicts.x).toContain("now also defines");
    const redundant = rebaseOverlay(overlay, { x: A }, digest);
    expect(redundant.changes).toEqual({});
    expect(redundant.conflicts).toEqual({});
  });
});

describe("observing the container's file", () => {
  test("in sync, pending after a restart Orkestrator did not write, and diverged", () => {
    const overlay = recordEdit(record({ a: A }), ["x"], { a: A, x: B }, digest);
    const materialised = { ...overlay, materialisedFingerprint: digest({ a: A, x: B }) };
    expect(observeOverlay(materialised, { a: A, x: B }, "boot-1", digest)).toEqual({
      kind: "in-sync",
    });
    expect(observeOverlay(materialised, { a: A }, "boot-2", digest)).toEqual({ kind: "pending" });
    expect(observeOverlay(materialised, { a: A2, x: B }, "boot-1", digest)).toEqual({
      kind: "diverged",
      names: ["a"],
    });
    // Without boot status only content can be compared.
    const legacy = { ...materialised, materialisedBootId: null };
    expect(observeOverlay(legacy, { a: A }, null, digest)).toEqual({
      kind: "diverged",
      names: ["x"],
    });
  });

  test("import adopts in-container edits but leaves a held conflict alone", () => {
    let overlay = record({ a: A, c: B });
    overlay = recordEdit(overlay, ["a"], { a: { command: "mine" }, c: B }, digest);
    overlay = rebaseOverlay(overlay, { a: A2, c: B }, digest);
    expect(overlay.conflicts.a).toBeDefined();
    const current = { a: A2, c: { command: "edited inside" }, extra: A };
    expect(divergedNames(overlay, current)).toEqual(["c", "extra"]);
    const imported = importCurrent(overlay, current, digest);
    expect(imported.conflicts.a).toBeDefined();
    expect(imported.changes.c).toEqual({
      kind: "set",
      entry: { command: "edited inside" },
      base: digest(B),
    });
    expect(imported.changes.extra).toEqual({ kind: "set", entry: A, base: null });
    expect(divergedNames(imported, current)).toEqual([]);
  });
});

describe("rewriting only the server map", () => {
  const json: SourceSpec = {
    sourceId: "claude:user",
    provider: "claude",
    scope: "environment-private",
    owner: "environment-overlay",
    format: "json",
    label: "x",
    path: "/home/node/.claude.json",
    displayPath: "x",
    subtree: ["mcpServers"],
    precedence: 1,
    writable: true,
    sharedWith: [],
    maxBytes: 1 << 20,
    createMode: 0o600,
  };
  const toml: SourceSpec = { ...json, format: "toml", subtree: ["mcp_servers"] };

  test("JSON keeps every other setting", () => {
    const text = `{\n  "theme": "dark",\n  "mcpServers": {\n    "a": { "command": "a" },\n    "b": { "command": "b" }\n  },\n  "projects": { "/w": {} }\n}\n`;
    const next = rewriteServerMap(json, text, { a: { command: "a2" }, c: { url: "https://c" } });
    const parsed = JSON.parse(next);
    expect(parsed.theme).toBe("dark");
    expect(parsed.projects).toEqual({ "/w": {} });
    expect(parsed.mcpServers).toEqual({ a: { command: "a2" }, c: { url: "https://c" } });
  });

  test("TOML keeps every other table, and an empty file gains the map", () => {
    const text = `model = "x"\n\n[mcp_servers.a]\ncommand = "a"\n\n[profiles.p]\nmodel = "y"\n`;
    const next = rewriteServerMap(toml, text, { b: { command: "b", args: ["--x"] } });
    const parsed = Bun.TOML.parse(next) as Record<string, unknown>;
    expect(parsed.model).toBe("x");
    expect(parsed.profiles).toEqual({ p: { model: "y" } });
    expect(parsed.mcp_servers).toEqual({ b: { command: "b", args: ["--x"] } });
    const fresh = Bun.TOML.parse(rewriteServerMap(toml, "", { a: A })) as Record<string, unknown>;
    expect(fresh.mcp_servers).toEqual({ a: A });
  });
});

for (const name of ["toString", "valueOf", "hasOwnProperty"]) {
  test(`overlay maps treat ${name} as an own server name`, () => {
    const added = recordEdit(record({}), [name], { [name]: A }, digest);
    expect(added.changes[name]).toEqual({ kind: "set", entry: A, base: null });
    expect(expectedEntries(added)).toEqual({ [name]: A });
    expect(publicOverlayState(added, null).added).toEqual([name]);
    const rebased = rebaseOverlay(added, {}, digest);
    expect(expectedEntries(rebased)).toEqual({ [name]: A });
    expect(recordEdit(rebased, [name], {}, digest).changes).toEqual({});
    const conflict = rebaseOverlay(added, { [name]: B }, digest);
    expect(Object.keys(conflict.conflicts)).toEqual([name]);
    expect(expectedEntries(conflict)).toEqual({ [name]: B });
    const removed = recordEdit(record({ [name]: A }), [name], {}, digest);
    expect(expectedEntries(rebaseOverlay(removed, {}, digest))).toEqual({});
    expect(divergedNames(added, {})).toEqual([name]);
    expect(importCurrent(added, {}, digest).changes).toEqual({});
  });
}
