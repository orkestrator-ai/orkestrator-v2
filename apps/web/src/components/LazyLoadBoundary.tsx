import {
  Component,
  Suspense,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Signatures browsers and bundlers use when a dynamic `import()` cannot be
 * fetched or evaluated. Matched against the message only — the message itself
 * is never rendered or logged, because it embeds the chunk URL.
 */
const MODULE_LOAD_ERROR_PATTERN =
  /dynamically imported module|importing a module script failed|error loading chunk|failed to fetch dynamically imported module/i;

export function isModuleLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChunkLoadError") return true;
  return MODULE_LOAD_ERROR_PATTERN.test(error.message);
}

export interface LazyLoadErrorDetails {
  /**
   * True when the chunk itself could not be fetched or evaluated. False when a
   * module loaded fine and then threw while rendering — the boundary catches
   * both, but only the first is fixed by reloading for a fresh copy.
   */
  isModuleLoadError: boolean;
  onReload: () => void;
}

interface LazyLoadErrorBoundaryProps {
  children: ReactNode;
  renderError: (details: LazyLoadErrorDetails) => ReactNode;
  onReload: () => void;
}

interface LazyLoadErrorBoundaryState {
  failed: boolean;
  isModuleLoadError: boolean;
}

class LazyLoadErrorBoundary extends Component<
  LazyLoadErrorBoundaryProps,
  LazyLoadErrorBoundaryState
> {
  state: LazyLoadErrorBoundaryState = {
    failed: false,
    isModuleLoadError: false,
  };

  static getDerivedStateFromError(error: unknown): LazyLoadErrorBoundaryState {
    return { failed: true, isModuleLoadError: isModuleLoadError(error) };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Do not echo or log the loader error. Chunk URLs can contain deployment
    // or filesystem details that do not belong in UI or telemetry.
  }

  render(): ReactNode {
    if (this.state.failed) {
      return this.props.renderError({
        isModuleLoadError: this.state.isModuleLoadError,
        onReload: this.props.onReload,
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
      detail: "Reload the application to recover.",
    };
}

/**
 * App-level failure surface. Use for boundaries that already own the whole
 * screen — a modal dialog, or a mount that has no visible container of its own.
 */
export function LazyLoadOverlayErrorFallback({
  isModuleLoadError: isModuleLoad,
  onReload,
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
        <Button onClick={onReload}>Reload application</Button>
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
        <Button onClick={onReload}>Reload application</Button>
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
}

export function LazyLoadBoundary({
  children,
  loadingFallback = null,
  renderError = (details) => <LazyLoadOverlayErrorFallback {...details} />,
  onReload = () => window.location.reload(),
}: LazyLoadBoundaryProps) {
  return (
    <LazyLoadErrorBoundary renderError={renderError} onReload={onReload}>
      <Suspense fallback={loadingFallback}>{children}</Suspense>
    </LazyLoadErrorBoundary>
  );
}

export function LazyDialogLoadingFallback({
  label = "Loading…",
}: {
  label?: string;
}) {
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
