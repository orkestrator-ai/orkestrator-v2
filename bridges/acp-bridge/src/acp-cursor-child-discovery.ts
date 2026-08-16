import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CURSOR_CHILD_DISCOVERY_SKEW_MS,
  MAX_CURSOR_DISCOVERY_ENTRIES,
  provider,
  sessions,
  workingDirectory,
  type BridgeToolPart,
  type SessionState,
} from "./acp-context.js";
import { findToolPart } from "./acp-tools.js";

/**
 * Cursor ids are short slugs. The cap is a sanity bound on an agent-supplied
 * value before it reaches the filesystem, well under any real path limit.
 */
const MAX_CURSOR_AGENT_ID_LENGTH = 128;

export function cursorTranscriptRoot(cwd: string = workingDirectory): string {
  const override = process.env.CURSOR_AGENT_TRANSCRIPTS_DIR?.trim();
  if (override) return override;
  const slug = cwd.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\//g, "-");
  return join(homedir(), ".cursor", "projects", slug, "agent-transcripts");
}

/**
 * The transcript path is built from an id the *agent* supplies, so it is
 * untrusted input crossing into the filesystem. Only a single safe path
 * segment may be used: anything containing a separator, a drive prefix or a
 * `..` traversal would read outside the transcript root and project the
 * result into the user's transcript.
 */
export function isSafeCursorAgentId(agentId: string): boolean {
  if (!agentId || agentId.length > MAX_CURSOR_AGENT_ID_LENGTH) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agentId) && !agentId.includes("..");
}

export function cursorChildTranscriptPath(
  agentId: string,
  cwd: string = workingDirectory,
): string | undefined {
  if (!isSafeCursorAgentId(agentId)) return undefined;
  return join(cursorTranscriptRoot(cwd), agentId, `${agentId}.jsonl`);
}

export interface DiscoveredCursorChild {
  agentId: string;
  createdAtMs: number;
}

interface DiscoveryCache {
  root: string;
  mtimeMs: number;
  createdAt: Map<string, number>;
  children: DiscoveredCursorChild[];
}

let discoveryCache: DiscoveryCache | undefined;

/**
 * Every Cursor child directory under the transcript root, oldest first.
 *
 * A directory appearing changes the root's mtime, so an unchanged root costs
 * one `stat` and returns the previous list — this runs behind
 * `/session/:id/messages`, which a visible tab polls twice a second. Entry
 * creation times are cached by name across scans, so a rescan only stats
 * directories it has not seen.
 */
export function discoverCursorChildTranscriptDirectories(): DiscoveredCursorChild[] {
  const root = cursorTranscriptRoot();
  let rootStats;
  try {
    rootStats = statSync(root);
  } catch {
    // A missing root is the normal state until the first child spawns.
    return [];
  }
  if (!rootStats.isDirectory()) return [];
  const cached = discoveryCache?.root === root ? discoveryCache : undefined;
  if (cached && cached.mtimeMs === rootStats.mtimeMs) return cached.children;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return cached?.children ?? [];
  }
  const createdAt = new Map<string, number>();
  const children: DiscoveredCursorChild[] = [];
  for (const entry of entries) {
    if (children.length >= MAX_CURSOR_DISCOVERY_ENTRIES) break;
    if (!entry.isDirectory() || !isSafeCursorAgentId(entry.name)) continue;
    let createdAtMs = cached?.createdAt.get(entry.name);
    if (createdAtMs === undefined) {
      try {
        const stats = statSync(join(root, entry.name));
        // `birthtimeMs` is 0 on filesystems that do not record creation.
        createdAtMs = stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs;
      } catch {
        continue;
      }
    }
    createdAt.set(entry.name, createdAtMs);
    children.push({ agentId: entry.name, createdAtMs });
  }
  children.sort((left, right) =>
    left.createdAtMs - right.createdAtMs || left.agentId.localeCompare(right.agentId)
  );
  discoveryCache = { root, mtimeMs: rootStats.mtimeMs, createdAt, children };
  return children;
}

interface UnboundCursorLaunch {
  toolUseId: string;
  startedAtMs: number;
}

/**
 * Bind running Task cards that have no `agentId` to child transcript
 * directories, so a *foreground* child's activity can be projected while it
 * runs.
 *
 * Cursor's ACP surface names a child exactly once, in the `cursor/task` frame
 * it sends after the launch tool completes. For a background launch that lands
 * while the card is still running, which is the case the watcher was built for.
 * A foreground `task` occupies its card for the child's entire lifetime and is
 * named only as it ends, so until then nothing on the wire connects the card to
 * the JSONL file the child is already writing.
 *
 * The filesystem does connect them: Cursor creates
 * `<root>/<agentId>/<agentId>.jsonl` seconds after the launch, and spawns
 * children in tool-call order. Pairing running unnamed cards against unclaimed
 * directories in creation order therefore recovers the mapping, subject to:
 *
 * - a directory older than its card (minus timestamp skew) is never that card's
 *   child, and
 * - a directory already bound to a live child of any session in this process is
 *   never taken from it.
 *
 * It is still an inference. If a card's child never writes a transcript, the
 * next card's directory is bound to it instead; the authoritative `agentId`
 * arriving with `cursor/task` re-anchors the card and
 * `syncCursorChildTranscriptParts` drops the superseded projection. Bindings
 * are marked `agentIdDiscovered` so nothing that must be certain — holding a
 * parent turn open — acts on one.
 */
export function bindDiscoveredCursorChildren(state: SessionState): boolean {
  if (provider !== "cursor") return false;
  const launches = unboundActiveLaunches(state);
  if (launches.length === 0) return false;
  const claimed = claimedCursorAgentIds(state);
  const candidates = discoverCursorChildTranscriptDirectories()
    .filter((child) => !claimed.has(child.agentId));
  if (candidates.length === 0) return false;

  let index = 0;
  let bound = false;
  for (const launch of launches) {
    const floor = launch.startedAtMs - CURSOR_CHILD_DISCOVERY_SKEW_MS;
    // Anything older than this card is older than every later card too, so it
    // is consumed rather than reconsidered.
    while (index < candidates.length && candidates[index]!.createdAtMs < floor) {
      index += 1;
    }
    const candidate = candidates[index];
    if (!candidate) break;
    index += 1;
    const previous = state.activeSubagentDescriptors.get(launch.toolUseId);
    state.activeSubagentDescriptors.set(launch.toolUseId, {
      ...previous,
      agentId: candidate.agentId,
      agentIdDiscovered: true,
    });
    bound = true;
  }
  return bound;
}

function unboundActiveLaunches(state: SessionState): UnboundCursorLaunch[] {
  const launches: UnboundCursorLaunch[] = [];
  for (const toolUseId of state.activeSubagentToolIds) {
    if (state.activeSubagentDescriptors.get(toolUseId)?.agentId) continue;
    const found = findToolPart(state, toolUseId);
    if (!found) continue;
    const startedAtMs = launchStartedAtMs(found.part);
    // Without a launch time there is no floor, and a card that cannot be
    // time-bounded could adopt any directory in the root.
    if (startedAtMs === undefined) continue;
    launches.push({ toolUseId, startedAtMs });
  }
  launches.sort((left, right) =>
    left.startedAtMs - right.startedAtMs || left.toolUseId.localeCompare(right.toolUseId)
  );
  return launches;
}

function launchStartedAtMs(part: BridgeToolPart): number | undefined {
  if (!part.createdAt) return undefined;
  const parsed = Date.parse(part.createdAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Ids that belong to a live child somewhere in this process. Sessions share one
 * transcript root — a bridge serves one working directory — so a second tab's
 * children are exactly what this must not steal. Settled children are omitted
 * deliberately: their directories predate any running card and are already
 * excluded by the time floor, and scanning every transcript for them would cost
 * a full pass per poll.
 */
function claimedCursorAgentIds(state: SessionState): Set<string> {
  const claimed = new Set<string>();
  const candidates = new Set<SessionState>(sessions.values());
  candidates.add(state);
  for (const candidate of candidates) {
    for (const descriptor of candidate.activeSubagentDescriptors.values()) {
      if (descriptor.agentId) claimed.add(descriptor.agentId);
    }
  }
  return claimed;
}

/** Test-only: drops the directory scan cache so a rewritten root is re-read. */
export function resetCursorChildDiscoveryCache(): void {
  discoveryCache = undefined;
}
