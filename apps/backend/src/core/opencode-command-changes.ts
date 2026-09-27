/**
 * Measured +N −M badges for OpenCode shell rows.
 *
 * OpenCode has no bridge process of ours: the backend watches `opencode serve`
 * over SSE, so this is the backend's copy of what each bridge does around its
 * shell calls (see `@orkestrator/protocol/workspace-change-probe`).
 *
 * OpenCode offers no pre-tool hook, only `message.part.updated` events after a
 * tool has started, so windows open in baseline mode: a snapshot is primed at
 * turn start, a `bash` part seen pending/running opens a window against it,
 * and the completed/error update closes it. Edit tools are noted rather than
 * measured, so an overlapping shell call is flagged approximate and the
 * baseline moves past the edit.
 *
 * Only a provider whose OpenCode server runs against a worktree this backend
 * can read measures anything. Local-worktree environments pass their host path
 * as the connection directory; a Docker environment's `/workspace` is a clone
 * inside the container with no host path, so its connection carries no
 * directory and its rows simply show no badge.
 *
 * The raw parts in the stream cache are replaced wholesale on every update, so
 * measurements live beside them, keyed by the part's `callID`, and are applied
 * where parts are normalized. A journal per session keeps them across backend
 * restarts. Every git call runs off the SSE loop and is failure-silent.
 */

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  CommandChangeJournal,
  hasMeasuredChanges,
  MAX_JOURNAL_ENTRIES,
} from "@orkestrator/protocol/command-change-journal";
import { isFileEditToolName, type MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { WorkspaceChangeProbe } from "@orkestrator/protocol/workspace-change-probe";
import { asRecord, nonEmptyString, setBoundedMapEntry } from "./agent-provider-runtime.js";

/** Under the backend data directory; one subdirectory per environment. */
export const OPENCODE_COMMAND_CHANGES_DIRECTORY = "opencode-command-changes";
/** OpenCode's shell tool. It has no background mode to exclude. */
const OPENCODE_SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["bash"]);
/** Tool calls whose end never arrives (a lost event) are dropped oldest first. */
const MAX_OPEN_CALLS = 256;
/** Sessions whose measurements are held in memory; evicted ones reload from their journal. */
const MAX_SESSIONS = 256;
const MAX_CACHED_JOURNALS = 1_024;

export type CommandChangeProbe = Pick<
  WorkspaceChangeProbe,
  "begin" | "note" | "end" | "discard" | "prime"
>;

export interface OpenCodeCommandChangeOptions {
  /**
   * Directory holding one journal per OpenCode session. Without one, badges
   * are live-only and a backend restart drops them.
   */
  journalDirectory?: string;
  /** Test seam; production shares one probe per backend process. */
  probe?: CommandChangeProbe;
}

let sharedProbe: WorkspaceChangeProbe | undefined;

/**
 * One probe per backend process, shared by every OpenCode provider: its
 * snapshot queue is per repository, so two providers on one worktree (a
 * restarted bridge, an observer and an interactive tab) must share it.
 */
function sharedWorkspaceChangeProbe(): WorkspaceChangeProbe {
  sharedProbe ??= new WorkspaceChangeProbe();
  return sharedProbe;
}

/** One journal instance per file, since appends serialize per instance. */
const journals = new Map<string, CommandChangeJournal>();

function journalAt(file: string): CommandChangeJournal {
  const existing = journals.get(file);
  if (existing) return existing;
  const created = new CommandChangeJournal(file);
  setBoundedMapEntry(journals, file, created, MAX_CACHED_JOURNALS);
  return created;
}

/** Ids are provider- or user-shaped; anything unusual becomes a hash, never a path. */
function safePathSegment(value: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value
    : createHash("sha256").update(value).digest("hex").slice(0, 40);
}

export function openCodeCommandChangeJournalDirectory(
  dataDir: string,
  environmentId: string,
): string {
  return path.join(dataDir, OPENCODE_COMMAND_CHANGES_DIRECTORY, safePathSegment(environmentId));
}

/** Delete an environment's journals. Never rejects. */
export async function removeOpenCodeCommandChangeJournals(
  dataDir: string,
  environmentId: string,
): Promise<void> {
  const directory = openCodeCommandChangeJournalDirectory(dataDir, environmentId);
  for (const file of journals.keys()) {
    if (path.dirname(file) === directory) journals.delete(file);
  }
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

type OpenCall = { sessionId: string; measure: boolean };

type SessionChanges = {
  changes: Map<string, MeasuredWorkspaceChange>;
  loaded?: Promise<void>;
};

export class OpenCodeCommandChanges {
  private readonly probe: CommandChangeProbe;
  /** Keyed by probe id, which namespaces the call id by session. */
  private readonly open = new Map<string, OpenCall>();
  private readonly sessions = new Map<string, SessionChanges>();
  /** Sessions whose current turn already has a baseline. */
  private readonly primed = new Set<string>();

  constructor(
    private readonly cwd: string,
    private readonly options: OpenCodeCommandChangeOptions,
    /** A new measurement exists for this session; must not throw. */
    private readonly onMeasured: (sessionId: string) => void,
  ) {
    this.probe = options.probe ?? sharedWorkspaceChangeProbe();
  }

  /**
   * Take the baseline a turn's first shell call is measured from, on
   * dispatch. A busy status primes too, so a turn started by another client
   * gets one, but only when this turn has none yet.
   */
  beginTurn(sessionId: string): void {
    this.primed.delete(sessionId);
    this.primeOnce(sessionId);
  }

  private primeOnce(sessionId: string): void {
    if (this.primed.has(sessionId)) return;
    if (this.primed.size >= MAX_SESSIONS) this.primed.clear();
    this.primed.add(sessionId);
    void this.probe.prime(this.cwd).catch(() => undefined);
  }

  /**
   * Feed one owned-session SSE event. Synchronous and cheap: every probe call
   * is fired and forgotten, so the event loop never waits on git.
   */
  observe(event: { type?: unknown; properties?: unknown }): void {
    const properties = asRecord(event.properties);
    if (event.type === "message.part.updated") {
      const part = asRecord(properties?.part);
      const sessionId = nonEmptyString(part?.sessionID) ?? nonEmptyString(properties?.sessionID);
      if (part && sessionId) this.observePart(sessionId, part);
      return;
    }
    const sessionId = nonEmptyString(properties?.sessionID);
    if (!sessionId) return;
    if (event.type === "session.status") {
      const status = asRecord(properties?.status)?.type;
      if (status === "busy") this.primeOnce(sessionId);
      else if (status === "idle") this.primed.delete(sessionId);
      return;
    }
    if (event.type === "session.idle") {
      this.primed.delete(sessionId);
      return;
    }
    if (event.type === "session.deleted") {
      void this.remove(sessionId).catch(() => undefined);
    }
  }

  private observePart(sessionId: string, part: Record<string, unknown>): void {
    if (part.type !== "tool") return;
    const callId = nonEmptyString(part.callID);
    const tool = nonEmptyString(part.tool)?.toLowerCase();
    if (!callId || !tool) return;
    const measure = OPENCODE_SHELL_TOOL_NAMES.has(tool);
    if (!measure && !isFileEditToolName(tool)) return;
    const key = probeKey(sessionId, callId);
    const status = asRecord(part.state)?.status;
    if (status === "pending" || status === "running") {
      if (this.open.has(key)) return;
      if (this.open.size >= MAX_OPEN_CALLS) {
        const oldest = this.open.keys().next().value;
        if (oldest !== undefined) {
          this.open.delete(oldest);
          this.probe.discard(oldest);
        }
      }
      this.open.set(key, { sessionId, measure });
      const opening = measure
        ? this.probe.begin(this.cwd, key, { baseline: true })
        : this.probe.note(this.cwd, key);
      void opening.catch(() => undefined);
      return;
    }
    if (status !== "completed" && status !== "error") return;
    // A completed part seen without its start (a reconnect, a restart) was
    // never windowed; later updates of a finished part land here too.
    const call = this.open.get(key);
    if (!call) return;
    this.open.delete(key);
    // An error still measures: an aborted or timed-out command may have
    // written before it stopped, and a denied one simply measures nothing.
    void this.probe
      .end(key)
      .then((change) => {
        if (call.measure && change && hasMeasuredChanges(change)) {
          this.record(sessionId, callId, change);
        }
      })
      .catch(() => undefined);
  }

  private record(sessionId: string, callId: string, change: MeasuredWorkspaceChange): void {
    const session = this.session(sessionId);
    session.changes.delete(callId);
    setBoundedMapEntry(session.changes, callId, change, MAX_JOURNAL_ENTRIES);
    void this.journal(sessionId)
      ?.append(callId, change)
      .catch(() => undefined);
    try {
      this.onMeasured(sessionId);
    } catch {
      // Only costs latency: the badge shows on the next transcript read.
    }
  }

  /**
   * Measurements for a session's shell calls by `callID`, including those a
   * previous backend process journaled. The journal is read once per session.
   */
  async changes(sessionId: string): Promise<ReadonlyMap<string, MeasuredWorkspaceChange>> {
    const session = this.session(sessionId);
    if (!session.loaded) {
      const journal = this.journal(sessionId);
      session.loaded = journal
        ? journal
            .read()
            .then((stored) => {
              // A live measurement taken while the read was in flight wins.
              for (const [callId, change] of stored) {
                if (!session.changes.has(callId)) {
                  setBoundedMapEntry(session.changes, callId, change, MAX_JOURNAL_ENTRIES);
                }
              }
            })
            .catch(() => undefined)
        : Promise.resolve();
    }
    await session.loaded;
    return session.changes;
  }

  /** Forget a released session's in-memory state; its journal stays for a resume. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.primed.delete(sessionId);
    for (const [key, call] of this.open) {
      if (call.sessionId !== sessionId) continue;
      this.open.delete(key);
      this.probe.discard(key);
    }
  }

  /** The OpenCode session itself was deleted: drop its journal too. */
  async remove(sessionId: string): Promise<void> {
    this.forget(sessionId);
    await this.journal(sessionId)?.remove();
  }

  dispose(): void {
    for (const key of this.open.keys()) this.probe.discard(key);
    this.open.clear();
    this.sessions.clear();
    this.primed.clear();
  }

  private session(sessionId: string): SessionChanges {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionChanges = { changes: new Map() };
    setBoundedMapEntry(this.sessions, sessionId, created, MAX_SESSIONS);
    return created;
  }

  private journal(sessionId: string): CommandChangeJournal | undefined {
    const directory = this.options.journalDirectory;
    return directory
      ? journalAt(path.join(directory, `${safePathSegment(sessionId)}.jsonl`))
      : undefined;
  }
}

/** The probe is shared by every provider, so ids carry their session. */
function probeKey(sessionId: string, callId: string): string {
  return `opencode:${sessionId}:${callId}`;
}
