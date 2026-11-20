import { createHash, randomBytes } from "node:crypto";
import { BUILD_PIPELINE_AGENTS } from "@orkestrator/protocol/build-pipeline";
import {
  TOOL_OUTPUT_PUSH_TOPIC,
  parseToolOutputPushKey,
  type NativeSessionPushKey,
  type NativeSessionPushPart,
  type PushStamp,
  type ToolOutputPushKey,
  type ToolOutputPushPart,
} from "@orkestrator/protocol/push-events";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { PushResolveAnswer, PushTopicProvider } from "./push-hub.js";

const log = createLogger("push");

export { TOOL_OUTPUT_PUSH_TOPIC };

/**
 * What the session's cached live view says about one call: content-free
 * (`NativeAgentToolOutputReads.toolOutputSource`). `null` when no view is
 * cached yet.
 */
export type ToolOutputSourceAnswer =
  | { located: false }
  | {
      located: true;
      detailRef?: string;
      toolState?: string;
      inlineOutput?: string;
      inlineError?: string;
      complete: boolean;
    }
  | null;

export interface ToolOutputPushTopicOptions {
  /** Keep the session observed and hear each of its changes; returns the release. */
  holdSession(
    key: NativeSessionPushKey,
    listener: (parts: readonly NativeSessionPushPart[]) => void,
  ): () => void;
  /** In-memory lookup of the call in the session's cached live view. */
  source(key: ToolOutputPushKey): ToolOutputSourceAnswer;
  /** Whether the session exists: the same lookup the `native-session` topic uses. */
  sessionExists(key: NativeSessionPushKey): Promise<boolean>;
  publish(key: string, stamp: PushStamp, parts: readonly ToolOutputPushPart[]): void;
}

interface Watch {
  parsed: ToolOutputPushKey;
  generation: string;
  revision: number;
  /** Content-free fingerprint of the call's output: reference, state, inline digest. */
  fingerprint: string | undefined;
  release: (() => void) | null;
}

export interface ToolOutputPushTopicMetrics {
  watches: number;
  /** Watches still holding their session (the call has not completed). */
  holding: number;
  checks: number;
  changes: number;
  completions: number;
}

function fingerprintOf(source: ToolOutputSourceAnswer): string | undefined {
  if (source === null) return undefined;
  if (!source.located) return "absent";
  // Track same-length rewrites without retaining inline content in the watch.
  const inlineDigest =
    source.inlineOutput !== undefined || source.inlineError !== undefined
      ? createHash("sha256")
          .update(JSON.stringify([source.inlineOutput, source.inlineError]))
          .digest("base64url")
      : "";
  return [
    source.detailRef ?? "",
    source.toolState ?? "",
    inlineDigest,
    source.complete ? 1 : 0,
  ].join("\0");
}

/**
 * The `tool-output` topic: one tool call's output in a native session
 * (docs/architecture/push-events.md, "The `tool-output` topic").
 *
 * It reads nothing of its own. While a key is retained it holds the call's
 * session through the `native-session` topic, so that session's one observer
 * keeps reading it, and on each change the observer announces it looks the
 * call up in the cached live view (memory only). When the call's reference,
 * state or inline body moved it announces `output`; the row then reads
 * from its cursor with `get_native_agent_tool_output`. Once the call has
 * completed and that was announced, it lets go of the session: the output no
 * longer changes. Release stops everything and keeps nothing.
 */
export class ToolOutputPushTopic implements PushTopicProvider {
  readonly topic = TOOL_OUTPUT_PUSH_TOPIC;
  private readonly watches = new Map<string, Watch>();
  private readonly processGeneration = randomBytes(6).toString("base64url");
  private generationCounter = 0;
  private readonly counters = { checks: 0, changes: 0, completions: 0 };

  constructor(private readonly options: ToolOutputPushTopicOptions) {}

  validKey(key: string): boolean {
    const parsed = parseToolOutputPushKey(key);
    return parsed !== null && (BUILD_PIPELINE_AGENTS as readonly string[]).includes(parsed.agent);
  }

  async resolve(key: string): Promise<PushResolveAnswer> {
    const parsed = parseToolOutputPushKey(key);
    if (!parsed) return { status: "denied" };
    if (!(await this.options.sessionExists(parsed))) return { status: "missing" };
    const watch = this.watches.get(key);
    if (!watch) return { status: "missing" };
    return { status: "ok", generation: watch.generation, revision: watch.revision };
  }

  retain(key: string): void {
    const parsed = parseToolOutputPushKey(key);
    if (!parsed || this.watches.has(key)) return;
    this.generationCounter += 1;
    const watch: Watch = {
      parsed,
      generation: `${this.processGeneration}.${this.generationCounter}`,
      revision: 0,
      fingerprint: undefined,
      release: null,
    };
    this.watches.set(key, watch);
    // The baseline: the row read once on expanding, and the subscribe
    // answer makes it read once more, so this announces nothing.
    watch.fingerprint = this.fingerprint(watch);
    if (this.completed(watch)) return;
    try {
      watch.release = this.options.holdSession(parsed, () => this.check(key, watch));
    } catch (error) {
      log.warn("tool-output.hold-failed", { error: formatLogError(error) });
    }
  }

  release(key: string): void {
    const watch = this.watches.get(key);
    if (!watch) return;
    this.watches.delete(key);
    this.letGo(watch);
  }

  metrics(): ToolOutputPushTopicMetrics {
    let holding = 0;
    for (const watch of this.watches.values()) if (watch.release) holding += 1;
    return { watches: this.watches.size, holding, ...this.counters };
  }

  dispose(): void {
    for (const key of Array.from(this.watches.keys())) this.release(key);
  }

  // -------------------------------------------------------------------------

  private fingerprint(watch: Watch): string | undefined {
    try {
      return fingerprintOf(this.options.source(watch.parsed));
    } catch (error) {
      log.debug("tool-output.source-failed", { error: formatLogError(error) });
      return undefined;
    }
  }

  private completed(watch: Watch): boolean {
    return watch.fingerprint !== undefined && watch.fingerprint.endsWith("\u00001");
  }

  private letGo(watch: Watch): void {
    const release = watch.release;
    watch.release = null;
    release?.();
  }

  private check(key: string, watch: Watch): void {
    if (this.watches.get(key) !== watch) return;
    this.counters.checks += 1;
    const next = this.fingerprint(watch);
    if (next === undefined || next === watch.fingerprint) return;
    watch.fingerprint = next;
    watch.revision += 1;
    this.counters.changes += 1;
    this.options.publish(key, { generation: watch.generation, revision: watch.revision }, [
      "output",
    ]);
    if (this.completed(watch)) {
      this.counters.completions += 1;
      this.letGo(watch);
    }
  }
}
