import { Component, type ErrorInfo, type ReactNode } from "react";
import { createLazyLoadFailureDiagnostic } from "@/components/LazyLoadBoundary";
import type {
  NativeMessage,
  NativeMessagePart,
} from "@/lib/chat/native-message-types";

interface MessageRenderBoundaryProps {
  children: ReactNode;
  /**
   * What "a newer version of this message" means for the retry. A transcript
   * poll that produces a different value here retries the row, so a frame that
   * failed mid-stream heals itself as soon as the next snapshot lands, without
   * the reader doing anything.
   *
   * Callers rendering the shared message model should pass
   * {@link messageRenderResetKey} rather than the message object: a poll
   * re-derives every message, so object identity changes on every refresh even
   * when nothing about the message did, and a row that fails for a *content*
   * reason would re-throw and re-log on every interval forever.
   */
  resetKey: unknown;
}

/** Nested part lists, so growth below the top level still counts as a change. */
function nestedParts(part: NativeMessagePart): NativeMessagePart[] | undefined {
  const grouped = part.type === "tool-group" || part.type === "agent-group"
    ? part.parts
    : part.type === "task-group"
      ? [part.task, ...part.childTools]
      : undefined;
  // Carried on the base part rather than a variant, so a subagent row's
  // streaming actions are folded in wherever they appear.
  const actions = part.subagentActions;
  if (grouped === undefined) return actions;
  return actions === undefined ? grouped : [...grouped, ...actions];
}

/**
 * Depth cap for the descriptor walk. The part model nests only a couple of
 * levels, so this never truncates real content — it exists so a malformed
 * projection cannot turn a reset-key computation into unbounded work in the
 * middle of a render.
 */
const MAX_DESCRIPTOR_DEPTH = 6;

function describePart(part: NativeMessagePart, depth: number): string {
  // Lengths rather than contents: the descriptor is recomputed on every render
  // of every visible row, and copying a streamed part's text into a key would
  // cost more than the render it guards. Two different bodies of exactly equal
  // length in the same slot are indistinguishable here, which costs one missed
  // retry — the next token to arrive changes the length and heals the row.
  const base =
    `${part.type}:${part.content.length}:${part.toolState ?? ""}:${part.agentState ?? ""}`;
  const nested = depth >= MAX_DESCRIPTOR_DEPTH ? undefined : nestedParts(part);
  return nested === undefined
    ? base
    : `${base}(${nested.map((child) => describePart(child, depth + 1)).join(",")})`;
}

/**
 * A reset key that changes when the message's rendered content changes, and
 * not merely when the object holding it was rebuilt.
 *
 * A read-only transcript view re-derives its whole message list on every poll,
 * so identity is a poor proxy for "this is worth rendering again": it retries a
 * deterministically failing row every few seconds for the life of the session,
 * each attempt throwing and logging again. A structural descriptor retries only
 * a message that actually moved.
 */
export function messageRenderResetKey(message: NativeMessage): string {
  return [
    message.id,
    message.role,
    message.content.length,
    ...message.parts.map((part) => describePart(part, 0)),
  ].join("|");
}

interface MessageRenderBoundaryState {
  failed: boolean;
}

/**
 * Contains a render failure to the one transcript row that threw.
 *
 * A transcript renders provider-controlled content, and a single message that
 * a renderer cannot survive must not replace the whole tab with its error
 * boundary — especially in read-only progress views, where the surrounding
 * messages are exactly what the user came to see. The failed row degrades to a
 * one-line note and retries when its `resetKey` reports a newer message.
 */
export class MessageRenderBoundary extends Component<
  MessageRenderBoundaryProps,
  MessageRenderBoundaryState
> {
  state: MessageRenderBoundaryState = { failed: false };

  static getDerivedStateFromError(): MessageRenderBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Same redaction rules as the view-level boundary: never the message or
    // stack, which can embed transcript content and absolute paths.
    console.error(
      "[MessageRenderBoundary] Message render failure",
      createLazyLoadFailureDiagnostic(error, info),
    );
  }

  // The retry compares the previous props against the current ones, exactly as
  // LazyLoadBoundary does. Deriving it from state written in componentDidCatch
  // would race React's post-error re-render, which runs getDerivedStateFromProps
  // before the catch lifecycle has recorded which key failed.
  componentDidUpdate(previousProps: MessageRenderBoundaryProps): void {
    if (
      this.state.failed
      && !Object.is(previousProps.resetKey, this.props.resetKey)
    ) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="px-6 py-2 text-center text-xs italic text-muted-foreground">
          One message could not be displayed. It will refresh with the next
          transcript update.
        </div>
      );
    }
    return this.props.children;
  }
}
