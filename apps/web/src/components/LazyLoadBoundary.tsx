import {
  Component,
  Suspense,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface LazyLoadErrorBoundaryProps {
  children: ReactNode;
  onReload: () => void;
}

interface LazyLoadErrorBoundaryState {
  failed: boolean;
}

class LazyLoadErrorBoundary extends Component<
  LazyLoadErrorBoundaryProps,
  LazyLoadErrorBoundaryState
> {
  state: LazyLoadErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): LazyLoadErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Do not echo or log the loader error. Chunk URLs can contain deployment
    // or filesystem details that do not belong in UI or telemetry.
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-background/80 p-6 backdrop-blur-sm">
          <div
            role="alert"
            className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-card p-6 text-center shadow-xl"
          >
            <AlertTriangle className="h-7 w-7 text-destructive" />
            <div>
              <p className="font-medium">This part of the app failed to load</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Reload the application to fetch a fresh copy.
              </p>
            </div>
            <Button onClick={this.props.onReload}>Reload application</Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

interface LazyLoadBoundaryProps {
  children: ReactNode;
  loadingFallback?: ReactNode;
  onReload?: () => void;
}

export function LazyLoadBoundary({
  children,
  loadingFallback = null,
  onReload = () => window.location.reload(),
}: LazyLoadBoundaryProps) {
  return (
    <LazyLoadErrorBoundary onReload={onReload}>
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
