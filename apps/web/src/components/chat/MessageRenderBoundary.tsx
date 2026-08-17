import { Component, type ErrorInfo, type ReactNode } from "react";
import { createLazyLoadFailureDiagnostic } from "@/components/LazyLoadBoundary";

interface MessageRenderBoundaryProps {
  children: ReactNode;
  /**
   * Identity of the rendered message. A transcript poll that replaces the
   * message object produces a new value here, which retries the row — a frame
   * that failed mid-stream heals itself as soon as the next snapshot lands,
   * without the reader doing anything.
   */
  resetKey: unknown;
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
 * one-line note and retries when its message is replaced by a newer snapshot.
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
