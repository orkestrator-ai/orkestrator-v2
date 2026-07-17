import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Globe2, Loader2, RefreshCw, Server, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { resolveBrowserAddress } from "@/lib/browser-address";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { BrowserTabData } from "@/types/paneLayout";

interface BrowserTabProps {
  tabId: string;
  environmentId: string;
  data: BrowserTabData;
  isActive: boolean;
  refreshRequestId?: number;
}

const OPAQUE_PREVIEW_SANDBOX = "allow-forms allow-pointer-lock allow-presentation allow-scripts";

export function BrowserTab({
  tabId,
  environmentId,
  data,
  isActive,
  refreshRequestId = 0,
}: BrowserTabProps) {
  const updateTabBrowserUrl = usePaneLayoutStore((state) => state.updateTabBrowserUrl);
  const [address, setAddress] = useState(data.url);
  const [currentUrl, setCurrentUrl] = useState(data.url);
  const [history, setHistory] = useState<string[]>(() => data.url ? [data.url] : []);
  const [historyIndex, setHistoryIndex] = useState(() => data.url ? 0 : -1);
  const [loadRevision, setLoadRevision] = useState(0);
  const [isLoading, setIsLoading] = useState(Boolean(data.url));
  const [error, setError] = useState<string | null>(null);
  const previousRefreshRequestId = useRef(refreshRequestId);
  const locallyPersistedUrl = useRef<string | null>(null);

  useEffect(() => {
    const followsLocalNavigation = locallyPersistedUrl.current === data.url;
    locallyPersistedUrl.current = null;
    setAddress(data.url);
    setCurrentUrl(data.url);
    if (!followsLocalNavigation) {
      setHistory(data.url ? [data.url] : []);
      setHistoryIndex(data.url ? 0 : -1);
      setIsLoading(Boolean(data.url));
      setError(null);
    }
  }, [data.url]);

  useEffect(() => {
    const refreshChanged = refreshRequestId !== previousRefreshRequestId.current;
    previousRefreshRequestId.current = refreshRequestId;
    if (refreshChanged && refreshRequestId > 0 && currentUrl) {
      setIsLoading(true);
      setLoadRevision((revision) => revision + 1);
    }
  }, [currentUrl, refreshRequestId]);

  const resolved = useMemo(() => {
    if (!currentUrl) return null;
    try {
      return resolveBrowserAddress(currentUrl);
    } catch {
      return null;
    }
  }, [currentUrl]);
  // Direct loopback previews need their real origin for normal browser behavior
  // (module loading, CORS, cookies, storage, and workers). Gateway previews are
  // served from the renderer's origin, so those must remain opaque to prevent a
  // preview from reaching the parent app or its authenticated gateway routes.
  // They also retain the referrer because gateway routing uses it to recover
  // runtime-built root-relative requests that cannot be statically rewritten.
  const isDirectPreview = resolved !== null && resolved.iframeUrl === resolved.displayUrl;
  const previewSandbox = isDirectPreview
    ? `${OPAQUE_PREVIEW_SANDBOX} allow-same-origin`
    : OPAQUE_PREVIEW_SANDBOX;
  const navigate = useCallback((nextAddress: string, recordHistory = true) => {
    let next;
    try {
      next = resolveBrowserAddress(nextAddress);
    } catch (navigationError) {
      setError(navigationError instanceof Error ? navigationError.message : String(navigationError));
      return;
    }

    setError(null);
    setAddress(next.displayUrl);
    setCurrentUrl(next.displayUrl);
    setIsLoading(true);
    setLoadRevision((revision) => revision + 1);
    locallyPersistedUrl.current = next.displayUrl;
    updateTabBrowserUrl(tabId, next.displayUrl, environmentId);

    if (recordHistory) {
      setHistory((current) => {
        const nextHistory = current.slice(0, historyIndex + 1);
        if (nextHistory[nextHistory.length - 1] !== next.displayUrl) {
          nextHistory.push(next.displayUrl);
        }
        setHistoryIndex(nextHistory.length - 1);
        return nextHistory;
      });
    }
  }, [environmentId, historyIndex, tabId, updateTabBrowserUrl]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigate(address);
  }, [address, navigate]);

  const moveThroughHistory = useCallback((offset: -1 | 1) => {
    const nextIndex = historyIndex + offset;
    const nextAddress = history[nextIndex];
    if (!nextAddress) return;
    setHistoryIndex(nextIndex);
    navigate(nextAddress, false);
  }, [history, historyIndex, navigate]);

  const reload = useCallback(() => {
    if (!currentUrl) return;
    setIsLoading(true);
    setLoadRevision((revision) => revision + 1);
  }, [currentUrl]);

  return (
    <div className={cn("absolute inset-0 flex flex-col bg-background", !isActive && "hidden")}>
      <div className="flex min-h-11 shrink-0 items-center gap-1.5 border-b border-border/80 bg-muted/25 px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Back"
          disabled={historyIndex <= 0}
          onClick={() => moveThroughHistory(-1)}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Forward"
          disabled={historyIndex < 0 || historyIndex >= history.length - 1}
          onClick={() => moveThroughHistory(1)}
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Reload preview"
          disabled={!currentUrl}
          onClick={reload}
        >
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
        </Button>

        <form className="flex min-w-0 flex-1 items-center" onSubmit={handleSubmit}>
          <div className={cn(
            "flex h-8 min-w-0 flex-1 items-center rounded-md border bg-background shadow-sm transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15",
            error ? "border-destructive/70" : "border-border",
          )}>
            <div className="hidden h-full shrink-0 items-center gap-1.5 border-r border-border/70 px-2.5 text-[11px] font-medium text-muted-foreground sm:flex">
              <Server className="h-3.5 w-3.5 text-primary" />
              Backend
            </div>
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent px-2.5 font-mono text-xs text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground"
              aria-label="Browser address"
              aria-invalid={Boolean(error)}
              placeholder="localhost:3000"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            {isLoading && <Loader2 className="mr-2 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
          </div>
          <Button type="submit" size="sm" className="ml-1.5 h-8 shrink-0 px-3">
            Go
          </Button>
        </form>
      </div>

      {error && (
        <div role="alert" className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-background">
        {resolved ? (
          <iframe
            key={`${resolved.iframeUrl}:${loadRevision}`}
            src={resolved.iframeUrl}
            data-load-revision={loadRevision}
            title="Backend browser preview"
            className="absolute inset-0 h-full w-full border-0 bg-white"
            sandbox={previewSandbox}
            referrerPolicy={isDirectPreview ? "no-referrer" : undefined}
            onLoad={() => setIsLoading(false)}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_center,hsl(var(--muted))_0,transparent_65%)] p-6 text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-background shadow-sm">
                <Globe2 className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-base font-semibold text-foreground">Preview a backend service</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Enter a local address such as <span className="font-mono text-foreground">localhost:3000</span>. The request runs through the backend machine.
              </p>
              <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-border bg-background/80 px-3 py-1 text-xs text-muted-foreground shadow-sm">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                Authenticated backend route
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
