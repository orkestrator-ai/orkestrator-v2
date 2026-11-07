import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { createLogger } from "@orkestrator/protocol/logger";
import { Button } from "@/components/ui/button";
import { createLazyLoadFailureDiagnostic } from "@/lib/failure-diagnostic";

const log = createLogger("web.node-scope");

export interface NodeErrorBoundaryProps {
  /** The node whose workspace this boundary holds; part of the log event, never the error. */
  nodeId: string;
  /** Names the machine in the message. */
  machine: string;
  children: ReactNode;
  /**
   * Called when the user retries, before the subtree mounts again. The owner
   * starts a fresh workspace document there, on the same scope.
   */
  onRetry?: () => void;
}

interface NodeErrorBoundaryState {
  failed: boolean;
}

/**
 * One node's workspace in the window's tree (report §5.2, §10.3): a render
 * error inside it shows a per-node error with Try again, and never reaches the window's shell or another node's workspace.
 *
 * Unmounting the failed subtree does not cancel the node's work (invariant
 * 2): its scope, services and backend work are not this boundary's. The log
 * event is content-free: the bounded diagnostic keeps an allowlisted error
 * type, a one-way fingerprint and component names, never the message.
 */
export class NodeErrorBoundary extends Component<NodeErrorBoundaryProps, NodeErrorBoundaryState> {
  state: NodeErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): NodeErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const diagnostic = createLazyLoadFailureDiagnostic(error, info);
    log.error("workspace.render-failed", {
      nodeId: this.props.nodeId,
      errorType: diagnostic.errorType,
      fingerprint: diagnostic.fingerprint,
      componentChain: diagnostic.componentChain.join(" > "),
    });
  }

  componentDidUpdate(previous: NodeErrorBoundaryProps): void {
    // Another node in the same slot starts clean.
    if (this.state.failed && previous.nodeId !== this.props.nodeId) this.reset();
  }

  private reset = (): void => {
    this.setState({ failed: false });
  };

  private retry = (): void => {
    try {
      this.props.onRetry?.();
    } catch {
      // A retry hook must not turn the fallback into a second crash.
    }
    this.reset();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm"
        data-testid="node-workspace-error"
        data-node={this.props.nodeId}
      >
        <p className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          {this.props.machine}&apos;s workspace stopped working.
        </p>
        <p className="max-w-sm text-muted-foreground">
          Its work keeps running on the machine. Try again to reopen the workspace.
        </p>
        <Button type="button" size="sm" variant="outline" onClick={this.retry}>
          Try again
        </Button>
      </div>
    );
  }
}
