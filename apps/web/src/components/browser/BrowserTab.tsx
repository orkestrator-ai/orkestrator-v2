import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ExternalLink, Globe2 } from "lucide-react";
import type { WebAnnotationPageIdentity } from "@orkestrator/protocol/web-annotations";
import {
  formatPreviewIntentUri,
  parsePreviewTabTarget,
} from "@orkestrator/protocol/preview-services";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  confirmLegacyUrlServiceMatch,
  legacyUrlHostPort,
  legacyUrlServiceMatch,
} from "@/lib/preview-service-entry";
import { openLinkExternally } from "@/lib/preview-link-external";
import { hasNativeBrowserPreview } from "@/lib/native/browser-preview";
import { paneLayoutStore, usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNodeScope } from "@/lib/node-scope/providers";
import {
  ensurePreviewServiceSync,
  previewServiceStore,
  usePreviewServiceStore,
} from "@/stores/previewServiceStore";
import type { BrowserTabData } from "@/types/paneLayout";
import { AnnotatedPreviewArea, AnnotationsButton } from "./annotations/BrowserAnnotationsLayout";
import { useBrowserAnnotations } from "./annotations/useBrowserAnnotations";
import {
  BROWSER_ADDRESS_FORM_CLASS,
  BROWSER_ADDRESS_FRAME_CLASS,
  BROWSER_ADDRESS_INPUT_CLASS,
  BROWSER_TOOLBAR_ACTIONS_CLASS,
  BROWSER_TOOLBAR_CLASS,
  useAddressBarShortcut,
} from "./browser-tab-hooks";
import { ServiceBrowserTab } from "./ServiceBrowserTab";

interface BrowserTabProps {
  tabId: string;
  environmentId: string;
  data: BrowserTabData;
  isActive: boolean;
  refreshRequestId?: number;
}

/**
 * Browser tabs are a registered preview service (durable service reference,
 * transport resolved at attach time) or an unresolved link. A plain URL tab
 * (a new tab, or one saved before service previews) has no in-app view: an
 * address typed into it is resolved to a service, and a saved address opens
 * in the user's browser unless it converts to the one service that owns it.
 */
export function BrowserTab(props: BrowserTabProps) {
  const target = parsePreviewTabTarget(props.data.url);
  if (target.kind !== "url") return <ServiceBrowserTab {...props} target={target} />;
  return <UrlBrowserTab {...props} />;
}

const NO_PAGE = null;

function UrlBrowserTab({ tabId, environmentId, data, isActive }: BrowserTabProps) {
  const updateTabBrowserUrl = usePaneLayoutStore((state) => state.updateTabBrowserUrl);
  const nativeBrowserPreview = hasNativeBrowserPreview();
  // The environment's node: its preview registry.
  const previewScope = useNodeScope();
  const currentUrl = data.url;
  const [address, setAddress] = useState(currentUrl);
  const [syncedUrl, setSyncedUrl] = useState(currentUrl);
  if (currentUrl !== syncedUrl) {
    setSyncedUrl(currentUrl);
    setAddress(currentUrl);
  }
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  useAddressBarShortcut({
    tabId,
    environmentId,
    isActive,
    enabled: true,
    inputRef: addressInputRef,
  });

  // Saved notes stay readable here; nothing is attached, so none are taken.
  const navigateToPage = useCallback(
    (page: WebAnnotationPageIdentity) => ({
      ok: false,
      message:
        page.service.kind === "service"
          ? "This note belongs to a registered preview service. Open that service in a browser tab to view it."
          : "This note was taken on a manual address, which no longer previews in the app. Open its service in a browser tab.",
    }),
    [],
  );
  const annotations = useBrowserAnnotations({
    tabId,
    environmentId,
    isActive,
    data,
    currentPage: NO_PAGE,
    previewAttached: false,
    navigateToPage,
  });

  // Migration belongs to the restored address only. Once the user or another
  // client changes it, returning to that address must not re-arm it.
  const [restoredNavigation] = useState({ url: data.url, requestId: data.navigationRequestId });
  const migrationEligible =
    data.url === restoredNavigation.url &&
    data.navigationRequestId === restoredNavigation.requestId;

  const conversionAttempt = useRef(0);
  const conversionMounted = useRef(false);
  useLayoutEffect(() => {
    conversionMounted.current = true;
    return () => {
      conversionMounted.current = false;
      conversionAttempt.current += 1;
    };
  }, []);
  useLayoutEffect(() => {
    conversionAttempt.current += 1;
  }, [data.url, data.navigationRequestId, environmentId]);

  // "Open as service": offered only when this tab's own environment has
  // exactly one current service on the URL's host port (see
  // `legacyUrlServiceMatch`). The port alone, or the active environment,
  // never decides it; an ambiguous port leaves the tab as it is.
  const legacyHostPort = useMemo(() => legacyUrlHostPort(currentUrl), [currentUrl]);
  const previewCapabilities = usePreviewServiceStore((state) => state.capabilities);
  const environmentPreviewSnapshot = usePreviewServiceStore(
    (state) => state.environments[environmentId]?.snapshot ?? null,
  );
  useEffect(() => {
    if (!isActive || legacyHostPort === null) return;
    ensurePreviewServiceSync(previewScope);
    void previewScope.store(previewServiceStore).getState().refreshEnvironment(environmentId);
  }, [environmentId, isActive, legacyHostPort, previewScope]);
  const serviceMatch = useMemo(
    () =>
      legacyUrlServiceMatch(
        currentUrl,
        environmentId,
        previewCapabilities,
        environmentPreviewSnapshot,
      ),
    [currentUrl, environmentId, environmentPreviewSnapshot, previewCapabilities],
  );
  const [serviceConversion, setServiceConversion] = useState<{
    url: string;
    state: "checking" | "changed" | "error";
    attempt: number;
  } | null>(null);
  const conversionState = serviceConversion?.url === currentUrl ? serviceConversion.state : null;
  const openAsService = useCallback(() => {
    if (!serviceMatch) return;
    const url = currentUrl;
    const attempt = ++conversionAttempt.current;
    // The tab's own node (the preview scope is this component's node scope).
    const liveData = () =>
      previewScope
        .store(paneLayoutStore)
        .getState()
        .getAllTabs(environmentId)
        .find((tab) => tab.id === tabId)?.browserData;
    const original = liveData();
    const isCurrent = () =>
      conversionMounted.current &&
      conversionAttempt.current === attempt &&
      liveData()?.url === original?.url &&
      liveData()?.navigationRequestId === original?.navigationRequestId;
    const clearCancelled = () =>
      setServiceConversion((current) => (current?.attempt === attempt ? null : current));
    setServiceConversion({ url, state: "checking", attempt });
    void confirmLegacyUrlServiceMatch(url, environmentId, serviceMatch, previewScope)
      .then((target) => {
        if (!isCurrent()) {
          if (conversionMounted.current) clearCancelled();
          return;
        }
        if (!target) {
          setServiceConversion({ url, state: "changed", attempt });
          return;
        }
        setServiceConversion(null);
        updateTabBrowserUrl(tabId, target, environmentId, [], -1);
      })
      .catch(() => {
        if (isCurrent()) setServiceConversion({ url, state: "error", attempt });
        else if (conversionMounted.current) clearCancelled();
      });
  }, [currentUrl, environmentId, previewScope, serviceMatch, tabId, updateTabBrowserUrl]);
  // Stored URL tabs migrate on their own once the tunnel can carry them. A
  // browser client or a disabled tunnel keeps the offer instead: converting
  // there would replace the tab with a setup message.
  // Keyed on the conversion state, not a ref, so StrictMode's cancelled first
  // attempt retries and a "changed" or "error" outcome waits for the user.
  const migrateToService =
    isActive &&
    nativeBrowserPreview &&
    migrationEligible &&
    serviceMatch !== null &&
    conversionState === null &&
    previewCapabilities?.surfaces.desktopTunnel.available === true;
  useEffect(() => {
    if (migrateToService) openAsService();
  }, [migrateToService, openAsService]);

  // A typed address is resolved by the backend in this environment, exactly
  // as a service tab's address bar does: a service, a choice, or an offer to
  // register the port. It never loads as a raw host port.
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const url = address.trim();
      if (!url) return;
      updateTabBrowserUrl(
        tabId,
        formatPreviewIntentUri({ environmentId, source: "address-bar", url }),
        environmentId,
        [],
        -1,
      );
    },
    [address, environmentId, tabId, updateTabBrowserUrl],
  );

  const openInBrowser = useCallback(() => {
    void openLinkExternally({
      environmentId,
      sourceTabId: tabId,
      url: currentUrl,
      scope: previewScope,
      unresolved: "gateway-proxy",
    });
  }, [currentUrl, environmentId, previewScope, tabId]);

  return (
    <div
      className={cn(
        "@container/browser absolute inset-0 flex min-w-0 flex-col overflow-hidden bg-background",
        !isActive && "hidden",
      )}
    >
      <div className={BROWSER_TOOLBAR_CLASS}>
        <form className={BROWSER_ADDRESS_FORM_CLASS} onSubmit={handleSubmit}>
          <div className={cn(BROWSER_ADDRESS_FRAME_CLASS, "border-border")}>
            <input
              ref={addressInputRef}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className={BROWSER_ADDRESS_INPUT_CLASS}
              aria-label="Browser address"
              placeholder="localhost:3000"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <Button type="submit" size="sm" className="ml-1.5 h-8 shrink-0 px-3">
            Go
          </Button>
        </form>
        <div className={BROWSER_TOOLBAR_ACTIONS_CLASS}>
          <AnnotationsButton annotations={annotations} />
        </div>
      </div>

      {serviceMatch && (
        <div
          role="status"
          className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/80 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
        >
          <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
            {conversionState === "changed"
              ? `The service on port ${legacyHostPort} changed while this was checked, so nothing was converted.`
              : conversionState === "error"
                ? "Could not check the preview service. Try again."
                : `Port ${legacyHostPort} is the ${serviceMatch.service.definition.label} preview service in this environment. As a service tab it follows the service when its port changes.`}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 shrink-0"
            disabled={conversionState === "checking"}
            onClick={openAsService}
          >
            Open as service
          </Button>
        </div>
      )}

      <AnnotatedPreviewArea annotations={annotations}>
        <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_center,hsl(var(--muted))_0,transparent_65%)] p-6 text-center">
          <div className="w-full min-w-0 max-w-sm">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-background shadow-sm">
              <Globe2 className="h-6 w-6 text-primary" />
            </div>
            {currentUrl ? (
              <>
                <h2 className="text-base font-semibold text-foreground break-words [overflow-wrap:anywhere]">
                  {currentUrl}
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  This address is not a preview service, so it opens in your browser. Enter it above
                  to open it as a service or register its port.
                </p>
                <Button type="button" className="mt-4 gap-2" onClick={openInBrowser}>
                  <ExternalLink className="h-4 w-4" />
                  Open in browser
                </Button>
              </>
            ) : (
              <>
                <h2 className="text-base font-semibold text-foreground">
                  Preview a backend service
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Enter a local address such as{" "}
                  <span className="font-mono text-foreground">localhost:3000</span>. It opens as the
                  environment's preview service on that port, or offers to register one.
                </p>
              </>
            )}
          </div>
        </div>
      </AnnotatedPreviewArea>
    </div>
  );
}
