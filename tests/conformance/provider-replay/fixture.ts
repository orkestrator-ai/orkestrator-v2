/**
 * The provider-replay fixture format, shared by every bridge that replays
 * recorded provider traffic through its production pipeline.
 *
 * A fixture is JSONL. The first line is a header naming the bridge, the
 * scenario and the provider version the traffic came from; every later line is
 * one step:
 *
 *   {"frame": <provider frame>}         traffic from the provider, in the
 *                                       bridge's own native shape (a Claude SDK
 *                                       message, a Cursor interaction update, a
 *                                       Pi session event, an ACP JSON-RPC line)
 *   {"action": "<name>", ...}           something the user, the backend or the
 *                                       provider runtime did between frames:
 *                                       answer an approval, interrupt, end the
 *                                       stream, restart the bridge, observe
 *
 * Frames are never interpreted here. Each bridge's adapter hands them to the
 * same function production hands them to, which is the point: an old frame
 * shape that a new adapter drops shows up as a changed expectation.
 */

export const PROVIDER_REPLAY_FORMAT_VERSION = 1 as const;

/** Bridges that replay through this shared suite. Codex has its own (below). */
export const PROVIDER_REPLAY_BRIDGES = ["claude", "cursor", "pi", "acp"] as const;
export type ProviderReplayBridge = (typeof PROVIDER_REPLAY_BRIDGES)[number];

export interface ProviderReplayHeader {
  replay: typeof PROVIDER_REPLAY_FORMAT_VERSION;
  bridge: ProviderReplayBridge;
  scenario: string;
  /**
   * `recorded`: captured from a real provider with the bridge's recorder and
   * scrubbed. `synthetic`: hand-written in the recorded shape, with no real
   * data, so the harness and the scenario are covered before a recording is.
   */
  source: "recorded" | "synthetic";
  /** Package or CLI whose traffic this is, e.g. `@cursor/sdk`. */
  provider: string;
  /** The pinned version the traffic was captured against, or written for. */
  providerVersion: string;
  description: string;
}

/** One line of traffic from the provider. */
export interface ProviderReplayFrameStep {
  kind: "frame";
  frame: unknown;
  rawLine?: string;
  line: number;
}

/**
 * Actions every adapter understands. An adapter that receives an action it
 * cannot perform throws, so a fixture can never silently skip a step.
 *
 * - `prompt`: start a turn (the bridge's real prompt path).
 * - `answer`: settle the oldest pending interaction (`decision` allow | deny).
 * - `interrupt`: the user stops the turn.
 * - `end`: the provider finishes the current turn's stream.
 * - `restart`: replace the bridge's in-memory state with what a successor
 *   process loads from disk, then reattach.
 * - `observe`: record a checkpoint with `label`.
 * - `drain`: wait until every frame so far has been consumed.
 *
 * Bridge-specific actions carry their own names and are documented in that
 * bridge's adapter.
 */
export interface ProviderReplayActionStep {
  kind: "action";
  action: string;
  args: Record<string, unknown>;
  line: number;
}

export type ProviderReplayStep = ProviderReplayFrameStep | ProviderReplayActionStep;

export interface ProviderReplayFixture {
  name: string;
  header: ProviderReplayHeader;
  steps: ProviderReplayStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parses a fixture, refusing anything ambiguous: a header that does not name
 * its bridge and provider version, a step that is neither a frame nor an
 * action, or a blank file. A fixture that half-parses would replay a different
 * scenario from the one its expectation was written for.
 */
export function parseProviderReplayFixture(name: string, text: string): ProviderReplayFixture {
  const lines = text.split("\n");
  let header: ProviderReplayHeader | undefined;
  const steps: ProviderReplayStep[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (raw.trim().length === 0) continue;
    const lineNumber = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`${name}:${lineNumber}: not JSON`);
    }
    if (!isRecord(value)) throw new Error(`${name}:${lineNumber}: not an object`);
    if (!header) {
      if (value.replay !== PROVIDER_REPLAY_FORMAT_VERSION) {
        throw new Error(`${name}:${lineNumber}: the first line must be a replay=1 header`);
      }
      if (!PROVIDER_REPLAY_BRIDGES.includes(value.bridge as ProviderReplayBridge)) {
        throw new Error(`${name}:${lineNumber}: unknown bridge ${String(value.bridge)}`);
      }
      if (value.source !== "recorded" && value.source !== "synthetic") {
        throw new Error(`${name}:${lineNumber}: source must be recorded or synthetic`);
      }
      for (const field of ["scenario", "provider", "providerVersion", "description"] as const) {
        if (!nonEmpty(value[field]))
          throw new Error(`${name}:${lineNumber}: header lacks ${field}`);
      }
      header = value as unknown as ProviderReplayHeader;
      continue;
    }
    if ("__recorderNotice" in value) {
      throw new Error(`${name}:${lineNumber}: capture did not finish within the byte cap`);
    }
    if ("rawLine" in value) {
      if (
        header.bridge !== "acp" ||
        typeof value.rawLine !== "string" ||
        /[\r\n]/.test(value.rawLine) ||
        Object.keys(value).length !== 1
      ) {
        throw new Error(`${name}:${lineNumber}: an ACP rawLine must be a single line`);
      }
      let frame: unknown;
      try {
        frame = JSON.parse(value.rawLine);
      } catch {
        // The bridge itself handles malformed wire traffic.
      }
      steps.push({ kind: "frame", frame, rawLine: value.rawLine, line: lineNumber });
      continue;
    }
    if ("frame" in value) {
      if (Object.keys(value).length !== 1) {
        throw new Error(`${name}:${lineNumber}: a frame step holds only "frame"`);
      }
      steps.push({ kind: "frame", frame: value.frame, line: lineNumber });
      continue;
    }
    if (nonEmpty(value.action)) {
      const { action, ...args } = value;
      steps.push({ kind: "action", action: action as string, args, line: lineNumber });
      continue;
    }
    throw new Error(`${name}:${lineNumber}: a step is either {"frame":…} or {"action":…}`);
  }
  if (!header) throw new Error(`${name}: empty fixture`);
  if (steps.length === 0) throw new Error(`${name}: a fixture needs at least one step`);
  return { name, header, steps };
}
