import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { createLogger } from "@orkestrator/protocol/logger";
import { Button } from "@/components/ui/button";
import {
  createLazyLoadFailureDiagnostic,
  isModuleLoadError,
  type LazyLoadFailureDiagnostic,
} from "@/lib/failure-diagnostic";
import { cn } from "@/lib/utils";

const log = createLogger("web.react");

// Re-exported for the boundaries and tests that already import them from here.
export { createLazyLoadFailureDiagnostic, isModuleLoadError, type LazyLoadFailureDiagnostic };

export interface LazyLoadErrorDetails {
  /**
   * True when the chunk itself could not be fetched or evaluated. False when a
   * module loaded fine and then threw while rendering — the boundary catches
   * both, but only the first is fixed by reloading for a fresh copy.
   */
  isModuleLoadError: boolean;
  onReload: () => void;
  /** Retry this boundary without reloading the application. */
  onRetry: () => void;
}

function resetKeysChanged(
  previous: readonly unknown[] | undefined,
  current: readonly unknown[] | undefined,
): boolean {
  if (!previous || !current) return previous !== current;
  return (
    previous.length !== current.length ||
    current.some((value, index) => !Object.is(value, previous[index]))
  );
}

interface LazyLoadErrorBoundaryProps {
  children: ReactNode;
  renderError: (details: LazyLoadErrorDetails) => ReactNode;
  onReload: () => void;
  resetKeys?: readonly unknown[];
  /**
   * Called with the bounded diagnostic when a failure is caught. Owners use
   * this to discard module-level state (persisted scroll snapshots, caches)
   * that outlives the remount — without it, state that contributed to the
   * crash replays the identical crash on every retry, so the "Retry view"
   * affordance can never succeed.
   */
  onError?: (diagnostic: LazyLoadFailureDiagnostic) => void;
}

interface LazyLoadErrorBoundaryState {
  failed: boolean;
  isModuleLoadError: boolean;
}

class LazyLoadErrorBoundary extends Component<
  LazyLoadErrorBoundaryProps,
  LazyLoadErrorBoundaryState
> {
  /** What the renderer error ring records as this boundary (`renderer-errors.ts`). */
  static readonly diagnosticBoundary = "lazy-view";

  state: LazyLoadErrorBoundaryState = {
    failed: false,
    isModuleLoadError: false,
  };

  static getDerivedStateFromError(error: unknown): LazyLoadErrorBoundaryState {
    return { failed: true, isModuleLoadError: isModuleLoadError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Never log the exception itself. Loader messages and component stacks can
    // contain chunk URLs, absolute paths, transcript text, or file contents.
    // The bounded diagnostic keeps only an allowlisted type, a one-way
    // fingerprint and component names extracted without source locations.
    const diagnostic = createLazyLoadFailureDiagnostic(error, info);
    log.error("lazy-view.failed", {
      kind: diagnostic.kind,
      errorType: diagnostic.errorType,
      fingerprint: diagnostic.fingerprint,
      componentChain: diagnostic.componentChain.join(" > "),
    });
    try {
      this.props.onError?.(diagnostic);
    } catch {
      // A cleanup hook must not replace the fallback with a second crash.
    }
  }

  componentDidUpdate(previousProps: LazyLoadErrorBoundaryProps): void {
    if (this.state.failed && resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)) {
      this.retry();
    }
  }

  private retry = (): void => {
    this.setState({ failed: false, isModuleLoadError: false });
  };

  render(): ReactNode {
    if (this.state.failed) {
      return this.props.renderError({
        isModuleLoadError: this.state.isModuleLoadError,
        onReload: this.props.onReload,
        onRetry: this.retry,
      });
    }

    return this.props.children;
  }
}

function errorCopy(isModuleLoad: boolean): { title: string; detail: string } {
  return isModuleLoad
    ? {
        title: "This part of the app failed to load",
        detail: "Reload the application to fetch a fresh copy.",
      }
    : {
        title: "Something went wrong in this view",
        detail: "Retry this view, or reload the application if it fails again.",
      };
}

/**
 * App-level failure surface. Use for boundaries that already own the whole
 * screen — a modal dialog, or a mount that has no visible container of its own.
 */
export function LazyLoadOverlayErrorFallback({
  isModuleLoadError: isModuleLoad,
  onReload,
  onRetry,
}: LazyLoadErrorDetails) {
  const { title, detail } = errorCopy(isModuleLoad);
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-background/80 p-6 backdrop-blur-sm">
      <div
        role="alert"
        className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-card p-6 text-center shadow-xl"
      >
        <AlertTriangle className="h-7 w-7 text-destructive" />
        <div>
          <p className="font-medium">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {!isModuleLoad && <Button onClick={onRetry}>Retry view</Button>}
          <Button variant={isModuleLoad ? "default" : "outline"} onClick={onReload}>
            Reload application
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Failure surface scoped to one container. A tab that is not on screen must not
 * take the whole application with it, so this fills its positioned ancestor and
 * hides entirely when the container is not visible.
 */
export function LazyLoadInlineErrorFallback({
  isModuleLoadError: isModuleLoad,
  onReload,
  onRetry,
  isVisible = true,
}: LazyLoadErrorDetails & { isVisible?: boolean }) {
  const { title, detail } = errorCopy(isModuleLoad);
  return (
    <div
      className={cn(
        "absolute inset-0 grid place-items-center bg-background/80 p-6",
        isVisible ? "z-10 pointer-events-auto" : "hidden",
      )}
    >
      <div
        role="alert"
        className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-card p-6 text-center shadow-lg"
      >
        <AlertTriangle className="h-7 w-7 text-destructive" />
        <div>
          <p className="font-medium">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {!isModuleLoad && <Button onClick={onRetry}>Retry view</Button>}
          <Button variant={isModuleLoad ? "default" : "outline"} onClick={onReload}>
            Reload application
          </Button>
        </div>
      </div>
    </div>
  );
}

interface LazyLoadBoundaryProps {
  children: ReactNode;
  loadingFallback?: ReactNode;
  /**
   * Renders the failure state. Defaults to an app-level overlay; pass a scoped
   * renderer when this boundary covers only part of the screen.
   */
  renderError?: (details: LazyLoadErrorDetails) => ReactNode;
  onReload?: () => void;
  /** Retry a failed child when any authoritative generation value changes. */
  resetKeys?: readonly unknown[];
  /** Discard state that outlives the remount; see LazyLoadErrorBoundaryProps. */
  onError?: (diagnostic: LazyLoadFailureDiagnostic) => void;
}

export function LazyLoadBoundary({
  children,
  loadingFallback = null,
  renderError = (details) => <LazyLoadOverlayErrorFallback {...details} />,
  onReload = () => window.location.reload(),
  resetKeys,
  onError,
}: LazyLoadBoundaryProps) {
  return (
    <LazyLoadErrorBoundary
      renderError={renderError}
      onReload={onReload}
      resetKeys={resetKeys}
      onError={onError}
    >
      <Suspense fallback={loadingFallback}>{children}</Suspense>
    </LazyLoadErrorBoundary>
  );
}

export function LazyDialogLoadingFallback({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="fixed inset-0 z-[100] grid place-items-center bg-background/70 backdrop-blur-sm"
    >
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-lg">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{label}</span>
      </div>
    </div>
  );
}
