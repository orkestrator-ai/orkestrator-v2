import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Code2, Globe2, Loader2, RefreshCw, Server, ShieldCheck } from "lucide-react";
import type { BrowserPreviewBounds, BrowserPreviewState } from "@orkestrator/protocol/browser-preview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { resolveBrowserAddress } from "@/lib/browser-address";
import {
  attachBrowserPreview,
  goBackBrowserPreview,
  goForwardBrowserPreview,
  hasNativeBrowserPreview,
  navigateBrowserPreview,
  openBrowserPreviewDevTools,
  reloadBrowserPreview,
  setBrowserPreviewVisible,
} from "@/lib/native/browser-preview";
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
const GATEWAY_PREVIEW_PATH = /^\/__orkestrator\/browser\/loopback\/([1-9]\d{0,4})(\/.*)?$/;
const BLOCKING_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
].join(",");

function displayUrlFromNativePreview(previewUrl: string, currentDisplayUrl: string): string | null {
  if (!previewUrl) return null;
  try {
    const preview = new URL(previewUrl);
    const gatewayMatch = GATEWAY_PREVIEW_PATH.exec(preview.pathname);
    if (!gatewayMatch) return preview.protocol === "http:" ? preview.toString() : null;

    const display = new URL(currentDisplayUrl);
    const displayPort = display.port || "80";
    if (gatewayMatch[1] !== displayPort) return null;
    display.pathname = gatewayMatch[2] ?? "/";
    display.search = preview.search;
    display.hash = preview.hash;
    return display.toString();
  } catch {
    return null;
  }
}

export function BrowserTab({
  tabId,
  environmentId,
  data,
  isActive,
  refreshRequestId = 0,
}: BrowserTabProps) {
  const updateTabBrowserUrl = usePaneLayoutStore((state) => state.updateTabBrowserUrl);
  const activePaneId = usePaneLayoutStore(
    (state) => state.environments.get(environmentId)?.activePaneId,
  );
  const owningPaneId = usePaneLayoutStore(
    (state) => state.findPaneWithTab(tabId, environmentId)?.id,
  );
  const nativeBrowserPreview = hasNativeBrowserPreview();
  const [address, setAddress] = useState(data.url);
  const [currentUrl, setCurrentUrl] = useState(data.url);
  const [history, setHistory] = useState<string[]>(() => data.url ? [data.url] : []);
  const [historyIndex, setHistoryIndex] = useState(() => data.url ? 0 : -1);
  const [loadRevision, setLoadRevision] = useState(0);
  const [isLoading, setIsLoading] = useState(Boolean(data.url));
  const [error, setError] = useState<string | null>(null);
  const previousRefreshRequestId = useRef(refreshRequestId);
  const locallyPersistedUrl = useRef<string | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const nativeAttachedRef = useRef(false);
  const [nativeState, setNativeState] = useState<BrowserPreviewState | null>(null);
  const [hasBlockingOverlay, setHasBlockingOverlay] = useState(false);

  const applyNativeState = useCallback((state: BrowserPreviewState | null) => {
    if (!state || state.tabId !== tabId) return;
    setNativeState(state);
    setIsLoading(state.loading);
    setError(state.error);

    const navigatedDisplayUrl = displayUrlFromNativePreview(state.url, currentUrl);
    if (!navigatedDisplayUrl || navigatedDisplayUrl === currentUrl) return;
    setAddress(navigatedDisplayUrl);
    setCurrentUrl(navigatedDisplayUrl);
    locallyPersistedUrl.current = navigatedDisplayUrl;
    updateTabBrowserUrl(tabId, navigatedDisplayUrl, environmentId);
  }, [currentUrl, environmentId, tabId, updateTabBrowserUrl]);

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
      if (nativeBrowserPreview && nativeAttachedRef.current) {
        void reloadBrowserPreview(tabId).then(applyNativeState).catch((reloadError) => {
          setIsLoading(false);
          setError(reloadError instanceof Error ? reloadError.message : String(reloadError));
        });
      } else if (!nativeBrowserPreview) {
        setLoadRevision((revision) => revision + 1);
      }
    }
  }, [applyNativeState, currentUrl, nativeBrowserPreview, refreshRequestId, tabId]);

  useEffect(() => {
    if (!nativeBrowserPreview) return;
    return window.orkestrator?.listen<BrowserPreviewState>("browser-preview-state", applyNativeState);
  }, [applyNativeState, nativeBrowserPreview]);

  const focusAddressBar = useCallback(() => {
    addressInputRef.current?.focus();
    addressInputRef.current?.select();
  }, []);

  useEffect(() => {
    if (!isActive) return;

    return window.orkestrator?.listen<string>(
      "browser-preview-focus-address",
      (requestedTabId) => {
        if (requestedTabId === tabId) focusAddressBar();
      },
    );
  }, [focusAddressBar, isActive, tabId]);

  useEffect(() => {
    if (!isActive || activePaneId !== owningPaneId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const isAddressShortcut =
        event.key.toLowerCase() === "l"
        && (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey;
      if (!isAddressShortcut) return;

      event.preventDefault();
      focusAddressBar();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activePaneId, focusAddressBar, isActive, owningPaneId]);

  useEffect(() => {
    if (!nativeBrowserPreview) return;
    const update = () => setHasBlockingOverlay(Boolean(document.querySelector(BLOCKING_OVERLAY_SELECTOR)));
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-state", "role"],
      childList: true,
      subtree: true,
    });
    update();
    return () => observer.disconnect();
  }, [nativeBrowserPreview]);

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
    if (!nativeBrowserPreview) setLoadRevision((revision) => revision + 1);
    locallyPersistedUrl.current = next.displayUrl;
    updateTabBrowserUrl(tabId, next.displayUrl, environmentId);

    if (nativeBrowserPreview && nativeAttachedRef.current) {
      void navigateBrowserPreview(tabId, next.iframeUrl).then(applyNativeState).catch((navigationError) => {
        setIsLoading(false);
        setError(navigationError instanceof Error ? navigationError.message : String(navigationError));
      });
    }

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
  }, [applyNativeState, environmentId, historyIndex, nativeBrowserPreview, tabId, updateTabBrowserUrl]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigate(address);
  }, [address, navigate]);

  const moveThroughHistory = useCallback((offset: -1 | 1) => {
    if (nativeBrowserPreview) {
      const action = offset === -1 ? goBackBrowserPreview : goForwardBrowserPreview;
      void action(tabId).then(applyNativeState).catch((navigationError) => {
        setError(navigationError instanceof Error ? navigationError.message : String(navigationError));
      });
      return;
    }
    const nextIndex = historyIndex + offset;
    const nextAddress = history[nextIndex];
    if (!nextAddress) return;
    setHistoryIndex(nextIndex);
    navigate(nextAddress, false);
  }, [applyNativeState, history, historyIndex, nativeBrowserPreview, navigate, tabId]);

  const reload = useCallback(() => {
    if (!currentUrl) return;
    setIsLoading(true);
    if (nativeBrowserPreview && nativeAttachedRef.current) {
      void reloadBrowserPreview(tabId).then(applyNativeState).catch((reloadError) => {
        setIsLoading(false);
        setError(reloadError instanceof Error ? reloadError.message : String(reloadError));
      });
      return;
    }
    setLoadRevision((revision) => revision + 1);
  }, [applyNativeState, currentUrl, nativeBrowserPreview, tabId]);

  useEffect(() => {
    if (!nativeBrowserPreview) return;
    const host = previewHostRef.current;
    if (!host || !resolved) {
      void setBrowserPreviewVisible(tabId, false);
      return;
    }

    let frame = 0;
    let disposed = false;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect();
        const bounds: BrowserPreviewBounds = {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        };
        void attachBrowserPreview({
          tabId,
          url: resolved.iframeUrl,
          bounds,
          visible: isActive && !hasBlockingOverlay,
        }).then((state) => {
          if (disposed) return;
          nativeAttachedRef.current = true;
          applyNativeState(state);
        }).catch((attachError) => {
          if (disposed) return;
          setIsLoading(false);
          setError(attachError instanceof Error ? attachError.message : String(attachError));
        });
      });
    };

    const observer = new ResizeObserver(sync);
    observer.observe(host);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    sync();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      void setBrowserPreviewVisible(tabId, false);
    };
  }, [applyNativeState, hasBlockingOverlay, isActive, nativeBrowserPreview, resolved, tabId]);

  const canGoBack = nativeBrowserPreview ? Boolean(nativeState?.canGoBack) : historyIndex > 0;
  const canGoForward = nativeBrowserPreview
    ? Boolean(nativeState?.canGoForward)
    : historyIndex >= 0 && historyIndex < history.length - 1;

  return (
    <div className={cn("@container/browser absolute inset-0 flex min-w-0 flex-col overflow-hidden bg-background", !isActive && "hidden")}>
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-border/80 bg-muted/25 px-2 py-1.5 @md/browser:flex-nowrap">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Back"
          disabled={!canGoBack}
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
          disabled={!canGoForward}
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

        <form
          className="flex w-full min-w-0 basis-full items-center @md/browser:w-auto @md/browser:basis-0 @md/browser:flex-1"
          onSubmit={handleSubmit}
        >
          <div className={cn(
            "flex h-8 min-w-0 flex-1 items-center rounded-md border bg-background shadow-sm transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15",
            error ? "border-destructive/70" : "border-border",
          )}>
            <div className="hidden h-full shrink-0 items-center gap-1.5 border-r border-border/70 px-2.5 text-[11px] font-medium text-muted-foreground @lg/browser:flex">
              <Server className="h-3.5 w-3.5 text-primary" />
              Backend
            </div>
            <input
              ref={addressInputRef}
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
        {nativeBrowserPreview && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label="Open preview DevTools"
            title="Open preview DevTools"
            disabled={!resolved || !nativeAttachedRef.current}
            onClick={() => {
              void openBrowserPreviewDevTools(tabId).then(applyNativeState).catch((devToolsError) => {
                setError(devToolsError instanceof Error ? devToolsError.message : String(devToolsError));
              });
            }}
          >
            <Code2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      {error && (
        <div role="alert" className="min-w-0 shrink-0 overflow-x-hidden border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive break-words [overflow-wrap:anywhere]">
          {error}
        </div>
      )}

      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
        {resolved && nativeBrowserPreview ? (
          <div
            ref={previewHostRef}
            data-native-browser-preview={tabId}
            className="absolute inset-0 block h-full min-h-0 w-full min-w-0 max-w-full bg-background"
          />
        ) : resolved ? (
          <iframe
            key={`${resolved.iframeUrl}:${loadRevision}`}
            src={resolved.iframeUrl}
            data-load-revision={loadRevision}
            title="Backend browser preview"
            className="absolute inset-0 block h-full min-h-0 w-full min-w-0 max-w-full border-0 bg-background [color-scheme:dark]"
            sandbox={previewSandbox}
            referrerPolicy={isDirectPreview ? "no-referrer" : undefined}
            onLoad={() => setIsLoading(false)}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_center,hsl(var(--muted))_0,transparent_65%)] p-6 text-center">
            <div className="w-full min-w-0 max-w-sm">
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
