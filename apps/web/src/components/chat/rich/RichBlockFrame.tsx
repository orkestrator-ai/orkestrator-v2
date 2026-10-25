import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The shared frame for rich transcript blocks (code, diagrams, tables,
 * charts, workflow snapshots, artifacts).
 *
 * - Toolbar actions are real buttons, excluded from document copy and find
 *   (`data-rich-chrome`, `select-none`, outside search roots).
 * - A failed renderer replaces only its own body: the body sits behind an
 *   error boundary whose fallback keeps the title, the toolbar and the
 *   caller's fallback slot (normally the exact source).
 * - Loading and final failures use a restrained polite live region; streaming
 *   tokens never announce.
 */

export interface RichBlockFrameProps {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  /** Toolbar buttons. Keep them hoisted/stable where possible. */
  actions?: ReactNode;
  children: ReactNode;
  /** Shown when the body throws or `error` is set: usually the exact source. */
  fallback?: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  error?: { title: string; detail?: string; action?: ReactNode } | null;
  className?: string;
  bodyClassName?: string;
  /** Stable identity for diagnostics and find-reveal targeting. */
  blockKey?: string;
  kind: string;
  /** Accessible group label when `title` is not plain text. */
  ariaLabel?: string;
}

export function RichBlockFrame({
  title,
  subtitle,
  status,
  actions,
  children,
  fallback,
  loading = false,
  loadingLabel = "Rendering…",
  error = null,
  className,
  bodyClassName,
  blockKey,
  kind,
  ariaLabel,
}: RichBlockFrameProps) {
  return (
    <figure
      role="group"
      aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
      data-rich-block={kind}
      data-rich-block-key={blockKey}
      className={cn(
        "not-prose my-2 min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-muted/40 text-sm",
        className,
      )}
    >
      <figcaption
        data-rich-chrome="true"
        className="flex min-h-8 select-none flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/70 px-2 py-1 text-xs"
      >
        <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
        {subtitle ? (
          <span className="min-w-0 truncate text-muted-foreground">{subtitle}</span>
        ) : null}
        {status ? <span className="shrink-0 text-muted-foreground">{status}</span> : null}
        {actions ? (
          <span
            role="toolbar"
            aria-label="Block actions"
            className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-0.5"
          >
            {actions}
          </span>
        ) : null}
      </figcaption>
      <div className={cn("relative min-w-0", bodyClassName)}>
        <span aria-live="polite" data-rich-chrome="true" className="sr-only">
          {loading
            ? loadingLabel
            : error
              ? `${error.title}${error.detail ? `: ${error.detail}` : ""}`
              : ""}
        </span>
        {error ? (
          <RichBlockError error={error}>{fallback}</RichBlockError>
        ) : (
          <RichBlockErrorBoundary fallback={fallback} kind={kind}>
            {children}
          </RichBlockErrorBoundary>
        )}
        {loading && !error ? (
          <span
            data-rich-chrome="true"
            className="pointer-events-none absolute right-2 top-2 flex select-none items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[11px] text-muted-foreground"
          >
            <Loader2
              aria-hidden="true"
              className="size-3 animate-spin motion-reduce:animate-none"
            />
            {loadingLabel}
          </span>
        ) : null}
      </div>
    </figure>
  );
}

function RichBlockError({
  error,
  children,
}: {
  error: NonNullable<RichBlockFrameProps["error"]>;
  children?: ReactNode;
}) {
  return (
    <div>
      <div
        role="note"
        data-rich-chrome="true"
        className="flex select-none items-start gap-2 border-b border-border/70 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
      >
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{error.title}</div>
          {error.detail ? (
            <div className="mt-0.5 break-words text-muted-foreground">{error.detail}</div>
          ) : null}
        </div>
        {error.action ? <div className="shrink-0">{error.action}</div> : null}
      </div>
      {children}
    </div>
  );
}

interface BoundaryProps {
  fallback?: ReactNode;
  kind: string;
  children: ReactNode;
}

class RichBlockErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Content-free: kind and error class only, never the block's source.
    console.warn(
      `[RichBlockFrame] ${this.props.kind} renderer failed:`,
      error instanceof Error ? error.name : "error",
      info.componentStack?.split("\n")[1]?.trim(),
    );
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <RichBlockError
        error={{
          title: "This block could not be displayed",
          detail: "The source is shown instead.",
        }}
      >
        {this.props.fallback}
      </RichBlockError>
    );
  }
}

/** A compact icon button for block toolbars with an accessible name and pressed state. */
export function RichToolbarButton({
  label,
  onClick,
  pressed,
  disabled,
  children,
  title,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      data-rich-chrome="true"
      className={cn(
        "inline-flex h-6 min-w-6 select-none items-center justify-center gap-1 rounded px-1 text-muted-foreground outline-none transition-colors hover:bg-elevated hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5",
        pressed && "bg-elevated text-foreground",
      )}
    >
      {children}
    </button>
  );
}
