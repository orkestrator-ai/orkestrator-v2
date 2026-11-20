import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { isIncompatibilityError } from "@orkestrator/protocol/contract/errors";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  TOOL_OUTPUT_READ_MAX_BYTES,
  TOOL_OUTPUT_TOOL_ID_MAX_BYTES,
  type NativeAgentToolOutputRead,
  type ToolOutputReadMode,
} from "@orkestrator/protocol/native-agent-tool-output";
import {
  PUSH_RECOVERY_POLL_MS,
  TOOL_OUTPUT_PUSH_TOPIC,
  formatToolOutputPushKey,
  pushUtf8Bytes,
} from "@orkestrator/protocol/push-events";
import type { IntervalTimers } from "@orkestrator/protocol/timers";
import { usePushSubscription } from "@/lib/push/push-subscriptions";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";

/**
 * The bounded, opt-in output tail of an expanded tool row
 * (docs/architecture/push-events.md, "The `tool-output` topic").
 *
 * Expanding a running call reads the tail of its output and subscribes to
 * the call's `tool-output` key; each change reads forward from the held end
 * (`range`) and appends. "Load earlier" reads history before the held start
 * (`before`). Collapsing releases the subscription, stops every timer and
 * drops the text: a collapsed row costs nothing. While the subscription is
 * not healthy the row polls at {@link TOOL_OUTPUT_FALLBACK_POLL_MS} until the
 * call completes.
 */

/** What a row needs to read its call's output on its node. */
export interface ToolOutputTailSource {
  scope: NodeScope;
  active?: boolean;
  environmentId: string;
  agent: AgentPlatform;
  logicalSessionKey: string;
  read(input: {
    environmentId: string;
    agent: AgentPlatform;
    logicalSessionKey: string;
    toolUseId: string;
    messageId?: string;
    detailRef?: string;
    mode: ToolOutputReadMode;
    cursor?: number;
    anchor?: string;
    limit: number;
  }): Promise<NativeAgentToolOutputRead>;
  /** The poll's clock; the runtime's when absent (tests pass a `ManualClock`). */
  timers?: IntervalTimers;
}

const runtimeIntervals: IntervalTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Provided by a live native agent tab; absent elsewhere (reviews, exports). */
export const ToolOutputTailContext = createContext<ToolOutputTailSource | null>(null);

/** The tail read on expanding, and each forward read. */
export const TOOL_OUTPUT_TAIL_READ_BYTES = 32 * 1024;
/** Each "load earlier" read. */
export const TOOL_OUTPUT_HISTORY_READ_BYTES = TOOL_OUTPUT_READ_MAX_BYTES;
/** The most output text one row holds; older text is dropped from the front. */
export const TOOL_OUTPUT_TAIL_MAX_HELD_BYTES = 512 * 1024;
/** Behind by more than this, a forward read jumps to the tail instead of catching up. */
const CATCH_UP_MAX_BYTES = 4 * TOOL_OUTPUT_TAIL_READ_BYTES;
/** Polling while the subscription is not healthy and the call still runs. */
export const TOOL_OUTPUT_FALLBACK_POLL_MS = 2_000;

export interface ToolOutputTailView {
  /** No answer yet. */
  loading: boolean;
  text: string;
  /** Bytes of output before the held text that this row does not hold. */
  earlierBytes: number;
  truncatedBefore: boolean;
  totalBytes: number;
  complete: boolean;
  toolError?: string;
  loadingEarlier: boolean;
  /** False once the row holds its byte bound. */
  canLoadEarlier: boolean;
  loadEarlier(): void;
}

interface Held {
  text: string;
  start: number;
  end: number;
  totalBytes: number;
  startAnchor?: string;
  endAnchor?: string;
  complete: boolean;
  toolError?: string;
}

/** Drop text from the front until it fits, at a line break where one is near. */
function trimFront(held: Held): Held {
  const excess = pushUtf8Bytes(held.text) - TOOL_OUTPUT_TAIL_MAX_HELD_BYTES;
  if (excess <= 0) return held;
  let cut = 0;
  let removedBytes = 0;
  for (const character of held.text) {
    cut += character.length;
    removedBytes += pushUtf8Bytes(character);
    if (removedBytes >= excess) break;
  }
  const newline = held.text.indexOf("\n", cut);
  if (newline >= 0 && newline - cut < 4096) {
    removedBytes += pushUtf8Bytes(held.text.slice(cut, newline + 1));
    cut = newline + 1;
  }
  // The start anchor described text this row no longer holds.
  return {
    ...held,
    text: held.text.slice(cut),
    start: held.start + removedBytes,
    startAnchor: undefined,
  };
}

function validOutputId(id: string, maxBytes: number): boolean {
  // In Unicode mode this matches only lone surrogate code units.
  return id.trim().length > 0 && !/[\uD800-\uDFFF]/u.test(id) && pushUtf8Bytes(id) <= maxBytes;
}

/**
 * The tail view of one call while `enabled`, or `null` when there is none to
 * show: no source (not a live tab), not enabled, or the node cannot serve it
 * (an older backend, or the call is no longer held), in which case the row
 * reads its details as before.
 */
export function useToolOutputTail(
  toolUseId: string | undefined,
  detailRef: string | undefined,
  enabled: boolean,
  messageId?: string,
): ToolOutputTailView | null {
  // A test double of the session may provide nothing.
  const source = useContext(ToolOutputTailContext) ?? null;
  const validIds =
    toolUseId !== undefined &&
    validOutputId(toolUseId, TOOL_OUTPUT_TOOL_ID_MAX_BYTES) &&
    (messageId === undefined || validOutputId(messageId, 512));
  const active =
    validIds && enabled && source !== null && source.active !== false && toolUseId !== undefined;
  const [held, setHeld] = useState<Held | null>(null);
  const [fallback, setFallback] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const heldRef = useRef<Held | null>(null);
  // Only a call outside the live view is read through it (the backend's choice).
  const detailRefRef = useRef(detailRef);
  useEffect(() => {
    detailRefRef.current = detailRef;
  }, [detailRef]);
  /** Bumped on every (de)activation: an answer for an older one is dropped. */
  const epochRef = useRef(0);
  const readingRef = useRef(false);
  const dirtyRef = useRef(false);

  const commit = useCallback((next: Held | null) => {
    heldRef.current = next;
    setHeld(next);
  }, []);

  const pushKey =
    active && source && toolUseId !== undefined
      ? formatToolOutputPushKey({
          environmentId: source.environmentId,
          agent: source.agent,
          logicalSessionKey: source.logicalSessionKey,
          toolUseId,
          ...(messageId === undefined ? {} : { messageId }),
        })
      : "";

  const readForward = useCallback(async () => {
    if (!active || !source || toolUseId === undefined) return;
    if (readingRef.current) {
      dirtyRef.current = true;
      return;
    }
    const epoch = epochRef.current;
    readingRef.current = true;
    try {
      do {
        dirtyRef.current = false;
        const current = heldRef.current;
        if (current?.complete) break;
        const result = await source.read({
          environmentId: source.environmentId,
          agent: source.agent,
          logicalSessionKey: source.logicalSessionKey,
          toolUseId,
          ...(messageId === undefined ? {} : { messageId }),
          ...(detailRefRef.current ? { detailRef: detailRefRef.current } : {}),
          ...(current
            ? {
                mode: "range" as const,
                cursor: current.end,
                ...(current.endAnchor ? { anchor: current.endAnchor } : {}),
              }
            : { mode: "tail" as const }),
          limit: TOOL_OUTPUT_TAIL_READ_BYTES,
        });
        if (epoch !== epochRef.current) return;
        if (result.status === "pending") continue;
        if (result.status !== "ok") {
          setFallback(true);
          return;
        }
        const base = heldRef.current;
        const behind = result.totalBytes - result.end;
        const complete = result.complete && behind === 0;
        let next: Held;
        if (!base || result.reset || result.start !== base.end) {
          next = {
            text: result.text,
            start: result.start,
            end: result.end,
            totalBytes: result.totalBytes,
            startAnchor: result.startAnchor,
            endAnchor: result.endAnchor,
            complete,
            ...(result.toolError ? { toolError: result.toolError } : {}),
          };
        } else {
          next = {
            ...base,
            text: base.text + result.text,
            end: result.end,
            totalBytes: result.totalBytes,
            endAnchor: result.endAnchor,
            complete,
            ...(result.toolError ? { toolError: result.toolError } : {}),
          };
        }
        if (behind > CATCH_UP_MAX_BYTES) {
          // Far behind: the next read takes the tail rather than every byte between.
          commit(null);
          dirtyRef.current = true;
          continue;
        }
        commit(trimFront(next));
        if (behind > 0 && result.end > result.start) dirtyRef.current = true;
      } while (dirtyRef.current && epoch === epochRef.current);
    } catch (error) {
      // Transport failures are retried on the next push or recovery poll.
      if (epoch === epochRef.current && isIncompatibilityError(error)) setFallback(true);
    } finally {
      if (epoch === epochRef.current) readingRef.current = false;
    }
  }, [active, commit, messageId, source, toolUseId]);

  // (De)activation: the first read on expanding; collapsing drops everything,
  // so the next expansion starts from the initial state.
  useEffect(() => {
    if (!active) return;
    epochRef.current += 1;
    readingRef.current = false;
    dirtyRef.current = false;
    heldRef.current = null;
    // Started from a microtask: the read's answers set state only after it.
    const epoch = epochRef.current;
    void Promise.resolve().then(() => {
      if (epoch === epochRef.current) return readForward();
    });
    return () => {
      epochRef.current += 1;
      readingRef.current = false;
      dirtyRef.current = false;
      heldRef.current = null;
      setHeld(null);
      setFallback(false);
      setLoadingEarlier(false);
    };
  }, [active, readForward]);

  const live = active && !fallback && held?.complete !== true;
  const onChange = useCallback(() => void readForward(), [readForward]);
  const subscription = usePushSubscription(
    source?.scope ?? appCommandScope(),
    TOOL_OUTPUT_PUSH_TOPIC,
    pushKey,
    live && pushKey !== "",
    onChange,
  );
  const healthy = subscription === "healthy";

  // A healthy subscription reads on frames, with the recovery poll as a net;
  // an unhealthy one polls while the call runs.
  const timers = source?.timers ?? runtimeIntervals;
  useEffect(() => {
    if (!live) return;
    const timer = timers.setInterval(
      () => void readForward(),
      healthy ? PUSH_RECOVERY_POLL_MS : TOOL_OUTPUT_FALLBACK_POLL_MS,
    );
    return () => timers.clearInterval(timer);
  }, [healthy, live, readForward, timers]);

  const loadEarlier = useCallback(() => {
    const current = heldRef.current;
    if (!active || !source || toolUseId === undefined || !current || current.start === 0) return;
    if (pushUtf8Bytes(current.text) >= TOOL_OUTPUT_TAIL_MAX_HELD_BYTES) return;
    const epoch = epochRef.current;
    setLoadingEarlier(true);
    void source
      .read({
        environmentId: source.environmentId,
        agent: source.agent,
        logicalSessionKey: source.logicalSessionKey,
        toolUseId,
        ...(messageId === undefined ? {} : { messageId }),
        ...(detailRefRef.current ? { detailRef: detailRefRef.current } : {}),
        mode: "before",
        cursor: current.start,
        ...(current.endAnchor ? { anchor: current.endAnchor } : {}),
        limit: TOOL_OUTPUT_HISTORY_READ_BYTES,
      })
      .then((result) => {
        if (epoch !== epochRef.current) return;
        if (result.status === "pending") return;
        if (result.status !== "ok") {
          setFallback(true);
          return;
        }
        const base = heldRef.current;
        if (!base) return;
        if (result.reset || result.end !== base.start) {
          // The output was rewritten under the row: start again from its tail.
          commit(null);
          void readForward();
          return;
        }
        const room = TOOL_OUTPUT_TAIL_MAX_HELD_BYTES - pushUtf8Bytes(base.text);
        if (pushUtf8Bytes(result.text) > room) return;
        commit({
          ...base,
          text: result.text + base.text,
          start: result.start,
          startAnchor: result.startAnchor,
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (epoch === epochRef.current) setLoadingEarlier(false);
      });
  }, [active, commit, messageId, readForward, source, toolUseId]);

  if (!active || fallback) return null;
  const heldBytes = held ? pushUtf8Bytes(held.text) : 0;
  return {
    loading: held === null,
    text: held?.text ?? "",
    earlierBytes: held?.start ?? 0,
    truncatedBefore: (held?.start ?? 0) > 0,
    totalBytes: held?.totalBytes ?? 0,
    complete: held?.complete ?? false,
    ...(held?.toolError ? { toolError: held.toolError } : {}),
    loadingEarlier,
    canLoadEarlier:
      heldBytes + Math.min(TOOL_OUTPUT_HISTORY_READ_BYTES, held?.start ?? 0) <=
      TOOL_OUTPUT_TAIL_MAX_HELD_BYTES,
    loadEarlier,
  };
}
