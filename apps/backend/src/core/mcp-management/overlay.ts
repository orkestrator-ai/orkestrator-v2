/**
 * The durable environment overlay: pure rules, no I/O.
 *
 * A container's provider homes inherit copies from `docker/entrypoint.sh`.
 * An absent staged input can leave the previous output intact on restart;
 * the file inside a container is never a durable statement of
 * what the user wants. The overlay is. For one container source it holds:
 *
 * - `baseline`: the inherited server entries as Orkestrator last saw them
 *   (the boot copy, or a refresh of the backend user's defaults);
 * - `changes`: this environment's intent relative to that baseline, by
 *   server name — `set` (an addition, or a replacement of an inherited
 *   entry) or `remove` (a tombstone, so a removed inherited server does not
 *   come back on the next boot or rebuild). Each change records the keyed
 *   digest of the inherited entry it was made against (`base`, `null` for an
 *   addition);
 * - `conflicts`: changes whose inherited entry has since changed or gone.
 *   They are held, not dropped, and their names keep the inherited value
 *   until the user decides;
 * - fingerprints of the baseline and of the server map Orkestrator last
 *   wrote, so an edit made inside the container is detected rather than
 *   overwritten.
 *
 * Only the server map is ever touched; other settings in the file stay
 * exactly as the container has them.
 */

import { createHmac } from "node:crypto";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { McpEnvironmentOverlayState } from "@orkestrator/protocol/mcp-management";

import { editSource, parseSource, type ParsedSource } from "./document.js";
import { tomlDeepEqual } from "./toml-edit.js";
import type { NativeEntry, SourceSpec } from "./types.js";

export const OVERLAY_SCHEMA_VERSION = 1;

export type OverlayChange =
  | { kind: "set"; entry: NativeEntry; base: string | null }
  | { kind: "remove"; base: string };

export interface OverlayRecord {
  schemaVersion: typeof OVERLAY_SCHEMA_VERSION;
  environmentId: string;
  provider: AgentPlatform;
  sourceId: string;
  revision: number;
  changes: Record<string, OverlayChange>;
  /** Name -> why the change cannot be reapplied over the current baseline. */
  conflicts: Record<string, string>;
  baseline: Record<string, NativeEntry>;
  baselineFingerprint: string;
  /** Fingerprint of the server map Orkestrator last wrote or verified. */
  materialisedFingerprint: string | null;
  /** Container boot that write belongs to; `null` for images without boot status. */
  materialisedBootId: string | null;
  materialisedAt: string | null;
  updatedAt: string;
}

/** Keyed digest of a JSON-shaped value; the key keeps it from confirming a guessed secret. */
export type Digest = (value: unknown) => string;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort())
      out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function overlayDigester(key: Buffer): Digest {
  return (value) =>
    `o1.${createHmac("sha256", key)
      .update(JSON.stringify(canonical(value)) ?? "null")
      .digest("base64url")
      .slice(0, 32)}`;
}

export function entriesOf(parsed: ParsedSource | null | undefined): Record<string, NativeEntry> {
  return parsed ? Object.fromEntries(parsed.entries) : {};
}

export function ownEntry<T>(map: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(map, name) ? map[name] : undefined;
}

const same = (a: unknown, b: unknown) => tomlDeepEqual(a, b);

export function newOverlayRecord(
  input: {
    environmentId: string;
    provider: AgentPlatform;
    sourceId: string;
    baseline: Record<string, NativeEntry>;
    bootId: string | null;
    now: string;
  },
  digest: Digest,
): OverlayRecord {
  const fingerprint = digest(input.baseline);
  return {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    environmentId: input.environmentId,
    provider: input.provider,
    sourceId: input.sourceId,
    revision: 0,
    changes: {},
    conflicts: {},
    baseline: structuredClone(input.baseline),
    baselineFingerprint: fingerprint,
    materialisedFingerprint: fingerprint,
    materialisedBootId: input.bootId,
    materialisedAt: input.now,
    updatedAt: input.now,
  };
}

/** The server map the container should hold: baseline plus every unconflicted change. */
export function expectedEntries(record: OverlayRecord): Record<string, NativeEntry> {
  const entries = structuredClone(record.baseline);
  for (const [name, change] of Object.entries(record.changes)) {
    if (ownEntry(record.conflicts, name) !== undefined) continue;
    if (change.kind === "set") entries[name] = structuredClone(change.entry);
    else delete entries[name];
  }
  return entries;
}

/**
 * Re-anchor the overlay on a new inherited baseline (a fresh boot copy, a
 * rebuild or a refreshed default). A change stays live when its inherited
 * entry is the one it was made against; a replacement the baseline now
 * matches exactly is redundant and dropped. Anything else becomes a
 * conflict: the change is kept, but its name shows the inherited value until
 * the user chooses. Nothing is silently resolved in either direction.
 */
export function rebaseOverlay(
  record: OverlayRecord,
  baseline: Record<string, NativeEntry>,
  digest: Digest,
): OverlayRecord {
  const next: OverlayRecord = {
    ...record,
    changes: { ...record.changes },
    conflicts: {},
    baseline: structuredClone(baseline),
    baselineFingerprint: digest(baseline),
  };
  for (const [name, change] of Object.entries(record.changes)) {
    const inherited = ownEntry(baseline, name);
    const inheritedDigest = inherited === undefined ? null : digest(inherited);
    if (change.kind === "set") {
      if (inherited !== undefined && same(inherited, change.entry)) {
        delete next.changes[name];
        continue;
      }
      if (inheritedDigest === change.base) continue;
      next.conflicts[name] =
        change.base === null
          ? `The inherited configuration now also defines "${name}".`
          : inherited === undefined
            ? `The inherited "${name}" was removed after this environment replaced it.`
            : `The inherited "${name}" changed after this environment replaced it.`;
    } else {
      // A tombstone outlives its server: if the same entry comes back, it stays removed.
      if (inherited === undefined || inheritedDigest === change.base) continue;
      next.conflicts[name] = `The inherited "${name}" changed after this environment removed it.`;
    }
  }
  return next;
}

/**
 * Record what one saved edit did to `names`, given the server map after it.
 * An entry edited back to its inherited value stops being a change. Editing a
 * conflicted name resolves that conflict with the user's new value.
 */
export function recordEdit(
  record: OverlayRecord,
  names: readonly string[],
  after: Record<string, NativeEntry>,
  digest: Digest,
): OverlayRecord {
  const next: OverlayRecord = {
    ...record,
    changes: { ...record.changes },
    conflicts: { ...record.conflicts },
  };
  for (const name of new Set(names)) {
    const value = ownEntry(after, name);
    const inherited = ownEntry(record.baseline, name);
    delete next.conflicts[name];
    if (value === undefined) {
      if (inherited === undefined) delete next.changes[name];
      else next.changes[name] = { kind: "remove", base: digest(inherited) };
    } else if (inherited !== undefined && same(value, inherited)) {
      delete next.changes[name];
    } else {
      next.changes[name] = {
        kind: "set",
        entry: structuredClone(value),
        base: inherited === undefined ? null : digest(inherited),
      };
    }
  }
  return next;
}

/** Names whose value in `current` differs from what the overlay expects. */
export function divergedNames(
  record: OverlayRecord,
  current: Record<string, NativeEntry>,
): string[] {
  const expected = expectedEntries(record);
  const names = new Set([...Object.keys(expected), ...Object.keys(current)]);
  return [...names]
    .filter((name) => !same(ownEntry(expected, name), ownEntry(current, name)))
    .sort();
}

/**
 * Adopt in-container edits as this environment's changes. A held conflict
 * whose name still shows the inherited value is left alone: the file says
 * nothing new about it.
 */
export function importCurrent(
  record: OverlayRecord,
  current: Record<string, NativeEntry>,
  digest: Digest,
): OverlayRecord {
  const names = divergedNames(record, current).filter(
    (name) =>
      !(
        ownEntry(record.conflicts, name) !== undefined &&
        same(ownEntry(current, name), ownEntry(record.baseline, name))
      ),
  );
  return recordEdit(record, names, current, digest);
}

export type OverlayObservation =
  | { kind: "in-sync" }
  /** The file holds the inherited copy of a boot Orkestrator has not written yet. */
  | { kind: "pending" }
  | { kind: "diverged"; names: string[] };

/**
 * Compare the container's file with what Orkestrator last wrote. A boot
 * Orkestrator has not written yet is a restart outside the start path: the
 * entrypoint re-copied the defaults, so the file is a fresh inherited copy
 * to rebase on, not a user's edit. Images without boot status (`null`) can
 * only be compared by content.
 */
export function observeOverlay(
  record: OverlayRecord,
  current: Record<string, NativeEntry>,
  bootId: string | null,
  digest: Digest,
): OverlayObservation {
  if (digest(current) === record.materialisedFingerprint) return { kind: "in-sync" };
  // A file that already holds the expected servers needs nothing, whatever
  // boot stamp the record carries (a write that landed before its record did).
  const names = divergedNames(record, current);
  if (!names.length) return { kind: "in-sync" };
  if (bootId !== null && bootId !== record.materialisedBootId) return { kind: "pending" };
  return { kind: "diverged", names };
}

export function publicOverlayState(
  record: OverlayRecord,
  observation: OverlayObservation | null,
): McpEnvironmentOverlayState {
  const added: string[] = [];
  const replaced: string[] = [];
  const removed: string[] = [];
  for (const [name, change] of Object.entries(record.changes)) {
    if (change.kind === "remove") removed.push(name);
    else if (ownEntry(record.baseline, name) === undefined && change.base === null)
      added.push(name);
    else replaced.push(name);
  }
  const conflicts = Object.entries(record.conflicts)
    .map(([name, reason]) => ({ name, reason }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const state: McpEnvironmentOverlayState["state"] =
    observation?.kind === "diverged"
      ? "diverged"
      : observation?.kind === "pending"
        ? "pending"
        : conflicts.length
          ? "conflict"
          : "in-sync";
  return {
    revision: record.revision,
    state,
    added: added.sort(),
    replaced: replaced.sort(),
    removed: removed.sort(),
    conflicts,
    divergedNames: observation?.kind === "diverged" ? observation.names : [],
    ...(record.materialisedAt ? { materialisedAt: record.materialisedAt } : {}),
  };
}

/**
 * Rewrite only the server map of `text` so it holds exactly `target`,
 * through the same verified single-entry edits a normal save uses. Other
 * settings, comments and formatting are kept; an entry whose layout cannot be
 * edited safely aborts the whole rewrite rather than being skipped.
 */
export function rewriteServerMap(
  spec: SourceSpec,
  text: string,
  target: Record<string, NativeEntry>,
): string {
  let current = text;
  let parsed = parseSource(spec, current);
  const step = (edit: Parameters<typeof editSource>[3]) => {
    current = editSource(spec, current, parsed, edit);
    parsed = parseSource(spec, current);
  };
  // Each step re-parses into a new map; this one stays the original's.
  const original = parsed.entries;
  for (const name of original.keys()) {
    if (ownEntry(target, name) === undefined) step({ kind: "remove", name });
  }
  for (const [name, entry] of Object.entries(target)) {
    const previous = parsed.entries.get(name);
    if (previous === undefined) step({ kind: "add", name, entry });
    else if (!same(previous, entry)) step({ kind: "update", name, previous, entry });
  }
  return current;
}
