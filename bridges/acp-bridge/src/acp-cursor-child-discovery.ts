import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CURSOR_CHILD_DISCOVERY_SKEW_MS,
  CURSOR_JSONL_SOURCE_PREFIX,
  MAX_CURSOR_DISCOVERY_ENTRIES,
  provider,
  sessions,
  workingDirectory,
  type BridgeToolPart,
  type SessionState,
} from "./acp-context.js";
import { findToolPart, toolPartAgentId } from "./acp-tools.js";

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
  limit: number;
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
 *
 * `limit` exists so a test can reach the entry cap without creating thousands
 * of directories; it is part of the cache key so a bounded scan can never be
 * served back to an unbounded one.
 */
export function discoverCursorChildTranscriptDirectories(
  limit: number = MAX_CURSOR_DISCOVERY_ENTRIES,
): DiscoveredCursorChild[] {
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
  if (cached && cached.mtimeMs === rootStats.mtimeMs && cached.limit === limit) {
    return cached.children;
  }

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    // An unreadable root is transient (a permissions change, a racing rename).
    // The previous list is stale rather than wrong, and dropping it would
    // unclaim every directory in it.
    return cached?.children ?? [];
  }
  const createdAt = new Map<string, number>();
  const children: DiscoveredCursorChild[] = [];
  for (const entry of entries) {
    if (children.length >= limit) break;
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
  discoveryCache = { root, mtimeMs: rootStats.mtimeMs, limit, createdAt, children };
  return children;
}

interface UnboundCursorLaunch {
  owner: SessionState;
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
 * - a directory already attributed to a card in this process — live or
 *   settled — is never taken from it.
 *
 * The pairing is computed over *every* session's unnamed launches, not just
 * this one's. A peer tab's anonymous card cannot reserve its directory by name
 * — it has no name yet — so a per-session pass let whichever tab polled first
 * take the peer's child. One global ordering gives every launch the same
 * answer regardless of who polls, and only the caller's own bindings are
 * written: a peer's launch merely consumes its candidate here, and the poll
 * that owns that session re-derives the identical pairing.
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
  const owners = discoverySessionStates(state);
  const launches = unboundActiveLaunches(owners);
  if (launches.length === 0) return false;
  // Ordered before the claim scan: with no directory to hand out there is
  // nothing to protect, and the scan is the expensive half.
  const directories = discoverCursorChildTranscriptDirectories();
  if (directories.length === 0) return false;
  const claimed = claimedCursorAgentIds(owners);
  const candidates = directories.filter((child) => !claimed.has(child.agentId));
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
    // A peer's launch has now consumed its candidate, which is the whole point
    // of the global pass, but the binding itself belongs to the poll that owns
    // that session. Writing it here would let one tab's read mutate another's.
    if (launch.owner !== state) continue;
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

/**
 * Every session that shares this process's transcript root, including one the
 * caller holds that is not (or is no longer) in the registry.
 */
function discoverySessionStates(state: SessionState): Set<SessionState> {
  const states = new Set<SessionState>(sessions.values());
  states.add(state);
  return states;
}

/**
 * Unnamed running Task cards across every session, oldest first.
 *
 * Both iteration orders feeding this are insertion-ordered and the sort is
 * stable, so repeated calls produce the same ordering — which is what lets a
 * peer session re-derive the same pairing on its own poll.
 */
function unboundActiveLaunches(states: Iterable<SessionState>): UnboundCursorLaunch[] {
  const launches: UnboundCursorLaunch[] = [];
  for (const owner of states) {
    for (const toolUseId of owner.activeSubagentToolIds) {
      if (owner.activeSubagentDescriptors.get(toolUseId)?.agentId) continue;
      const found = findToolPart(owner, toolUseId);
      if (!found) continue;
      const startedAtMs = launchStartedAtMs(found.part);
      // Without a launch time there is no floor, and a card that cannot be
      // time-bounded could adopt any directory in the root.
      if (startedAtMs === undefined) continue;
      launches.push({ owner, toolUseId, startedAtMs });
    }
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
 * Ids already attributed to a card somewhere in this process. Sessions share
 * one transcript root, so a second tab's children are exactly what this must
 * not steal.
 *
 * Live descriptors are not enough: a foreground Task is named only as it
 * settles, and settling deletes the descriptor. The 5s creation-time floor
 * does not exclude that directory from the *next* unnamed launch — sequential
 * short Tasks are newer than the floor. This scan therefore also reads
 * `agentId` off launch parts and off JSONL projections still attached to a
 * card. It runs only while an unnamed launch is waiting to bind and a
 * directory is available to bind it to, not on the `/activity` poll.
 */
function claimedCursorAgentIds(states: Iterable<SessionState>): Set<string> {
  const claimed = new Set<string>();
  for (const candidate of states) {
    for (const descriptor of candidate.activeSubagentDescriptors.values()) {
      if (descriptor.agentId) claimed.add(descriptor.agentId);
    }
    for (const message of candidate.messages) {
      for (const part of message.parts) {
        const projectedId = cursorJsonlPartAgentId(part.sourcePartId);
        if (projectedId) claimed.add(projectedId);
        if (part.type !== "tool-invocation" || part.parentTaskUseId) continue;
        if (!isSubagentLaunchPart(part)) continue;
        const agentId = toolPartAgentId(part);
        if (agentId) claimed.add(agentId);
      }
    }
  }
  return claimed;
}

/**
 * A Task card — the only part that can carry a Cursor `agentId`.
 *
 * Ordinary tool calls have to be excluded by more than the `agentId` lookup
 * failing on them: `toolPartAgentId` falls through to parsing `toolOutput` as
 * JSON, which for a `Read` or `Bash` result means scanning and failing to
 * parse up to `MAX_TOOL_OUTPUT_BYTES`. Doing that for every part of every
 * message would put a whole extra transcript pass on `/session/:id/messages`,
 * which a visible tab polls twice a second — the exact cost
 * `boundTranscriptForRead` exists to keep off that route.
 */
function isSubagentLaunchPart(part: BridgeToolPart): boolean {
  return part.agentState !== undefined || part.toolName?.trim().toLowerCase() === "task";
}

/** Agent id encoded in a projected `cursor-jsonl:<agentId>:…` part. */
function cursorJsonlPartAgentId(sourcePartId: string): string | undefined {
  if (!sourcePartId.startsWith(CURSOR_JSONL_SOURCE_PREFIX)) return undefined;
  const agentId = sourcePartId.slice(CURSOR_JSONL_SOURCE_PREFIX.length).split(":")[0];
  return agentId && isSafeCursorAgentId(agentId) ? agentId : undefined;
}

/** Test-only: drops the directory scan cache so a rewritten root is re-read. */
export function resetCursorChildDiscoveryCache(): void {
  discoveryCache = undefined;
}
