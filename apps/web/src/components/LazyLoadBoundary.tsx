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
  /** Retry this boundary without reloading the application. */
  onRetry: () => void;
}

export interface LazyLoadFailureDiagnostic {
  kind: "module-load" | "render";
  /**
   * An allowlisted built-in error name, `NonErrorThrow` when the thrown value
   * was not an `Error`, or `Error` for anything else. Never a custom subclass
   * name, which application code controls and could embed untrusted text.
   */
  errorType: string;
  fingerprint: string;
  componentChain: string[];
}

/** Fixed sentinel for a thrown value that was not an `Error` at all. */
const NON_ERROR_THROW = "NonErrorThrow";

const SAFE_ERROR_TYPES = new Set([
  "AggregateError",
  "ChunkLoadError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

function failureFingerprint(value: string): string {
  // FNV-1a is not used as a security primitive here. It gives support logs a
  // stable correlation key without retaining the exception message, stack,
  // chunk URL, absolute path, or transcript content that produced it.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Build a bounded diagnostic that cannot echo provider or filesystem data. */
export function createLazyLoadFailureDiagnostic(
  error: unknown,
  info?: Pick<ErrorInfo, "componentStack">,
): LazyLoadFailureDiagnostic {
  let rawName = NON_ERROR_THROW;
  let stack = "";
  if (error instanceof Error) {
    try {
      rawName = error.name;
      stack = error.stack ?? "";
    } catch {
      rawName = "Error";
    }
  }
  // The sentinel is a fixed literal rather than attacker-influenced text, so
  // preserving it alongside the allowlist keeps "nobody threw an Error" visible
  // without letting a custom subclass name reach the log.
  const errorType = rawName === NON_ERROR_THROW || SAFE_ERROR_TYPES.has(rawName)
    ? rawName
    : "Error";
  const componentStack = info?.componentStack ?? "";
  const componentChain = componentStack
    .split("\n")
    .flatMap((line) => {
      // The trailing lookahead is what keeps a location-only frame out of the
      // chain: React writes `at Name (loc)` or `at Name`, so a line such as
      // `at https://host/assets/chunk.js:2:2` fails on the `:` and is dropped
      // rather than contributing a bare `https`.
      const match = /^\s*at\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?=\s|\(|$)/
        .exec(line);
      return match?.[1] ? [match[1]] : [];
    })
    .slice(0, 12);
  return {
    kind: isModuleLoadError(error) ? "module-load" : "render",
    errorType,
    fingerprint: failureFingerprint(`${errorType}\n${stack}\n${componentStack}`),
    componentChain,
  };
}

function resetKeysChanged(
  previous: readonly unknown[] | undefined,
  current: readonly unknown[] | undefined,
): boolean {
  if (!previous || !current) return previous !== current;
  return previous.length !== current.length
    || current.some((value, index) => !Object.is(value, previous[index]));
}

interface LazyLoadErrorBoundaryProps {
  children: ReactNode;
  renderError: (details: LazyLoadErrorDetails) => ReactNode;
  onReload: () => void;
  resetKeys?: readonly unknown[];
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

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Never log the exception itself. Loader messages and component stacks can
    // contain chunk URLs, absolute paths, transcript text, or file contents.
    // The bounded diagnostic keeps only an allowlisted type, a one-way
    // fingerprint and component names extracted without source locations.
    console.error(
      "[LazyLoadBoundary] View failure",
      createLazyLoadFailureDiagnostic(error, info),
    );
  }

  componentDidUpdate(previousProps: LazyLoadErrorBoundaryProps): void {
    if (
      this.state.failed
      && resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)
    ) {
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
}

export function LazyLoadBoundary({
  children,
  loadingFallback = null,
  renderError = (details) => <LazyLoadOverlayErrorFallback {...details} />,
  onReload = () => window.location.reload(),
  resetKeys,
}: LazyLoadBoundaryProps) {
  return (
    <LazyLoadErrorBoundary
      renderError={renderError}
      onReload={onReload}
      resetKeys={resetKeys}
    >
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
