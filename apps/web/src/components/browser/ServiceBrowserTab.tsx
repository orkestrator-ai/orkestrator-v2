import { lazy, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  ExternalLink,
  Globe2,
  Link2,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import type {
  BrowserPreviewBounds,
  BrowserPreviewServiceTarget,
  BrowserPreviewState,
  BrowserPreviewTransportState,
} from "@orkestrator/protocol/browser-preview";
import {
  formatPreviewServiceUri,
  previewErrorFromUnknown,
  type PreviewServiceDefinition,
  type PreviewServiceRef,
  type PreviewServiceSnapshot,
  type PreviewTabTarget,
} from "@orkestrator/protocol/preview-services";
import { toast } from "sonner";

import { LazyDialogLoadingFallback, LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import * as backend from "@/lib/backend";
import { resolveBrowserAddress } from "@/lib/browser-address";
import {
  attachBrowserPreview,
  goBackBrowserPreview,
  goForwardBrowserPreview,
  hasNativeBrowserPreview,
  openBrowserPreviewDevTools,
  reloadBrowserPreview,
  resetBrowserPreviewServiceSiteData,
  setBrowserPreviewVisible,
} from "@/lib/native/browser-preview";
import { openServiceExternally } from "@/lib/preview-external";
import {
  diagnoseService,
  parseServiceAddressInput,
  serviceDisplayUrl,
  serviceReadiness,
  type DiagnosisAction,
} from "@/lib/preview-service-display";
import { cn } from "@/lib/utils";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { getAllLeaves, usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { ensurePreviewServiceSync, usePreviewServiceStore } from "@/stores/previewServiceStore";
import type { BrowserTabData } from "@/types/paneLayout";
import { errorMessage, useBlockingOverlay, useBrowserPreviewAnnotation } from "./browser-tab-hooks";
import { PreviewDiagnostics } from "./PreviewDiagnostics";
import { PreviewServiceDialog } from "./PreviewServiceDialog";
import { PreviewServicePicker, ReadinessDot } from "./PreviewServicePicker";

const LazyEnvironmentSettingsDialog = lazy(async () => ({
  default: (await import("@/components/environments/EnvironmentSettingsDialog"))
    .EnvironmentSettingsDialog,
}));

type ServiceTarget = Extract<PreviewTabTarget, { kind: "service" | "intent" }>;

export interface ServiceBrowserTabProps {
  tabId: string;
  environmentId: string;
  data: BrowserTabData;
  isActive: boolean;
  refreshRequestId?: number;
  target: ServiceTarget;
}

type Mode = "desktop-tunnel" | "compatibility" | "top-level" | "unsupported";

export function ServiceBrowserTab(props: ServiceBrowserTabProps) {
  const { target } = props;
  useEffect(() => ensurePreviewServiceSync(), []);
  if (target.kind === "intent") return <PreviewIntentChooser {...props} target={target} />;
  return <ServicePreview {...props} serviceRef={target.ref} />;
}

function useEnvironmentServices(environmentId: string, isActive: boolean) {
  const capabilities = usePreviewServiceStore((state) => state.capabilities);
  const status = usePreviewServiceStore((state) => state.status);
  const environment = usePreviewServiceStore((state) => state.environments[environmentId]);
  const refreshEnvironment = usePreviewServiceStore((state) => state.refreshEnvironment);
  // Rehydrate from the authoritative snapshot whenever the tab becomes active:
  // events may have been missed while it was hidden.
  useEffect(() => {
    if (isActive) void refreshEnvironment(environmentId);
  }, [environmentId, isActive, refreshEnvironment]);
  return {
    capabilities,
    status,
    services: environment?.snapshot?.services ?? [],
    snapshotLoaded: Boolean(environment?.snapshot),
    refreshEnvironment,
  };
}

/** Replace this tab's durable target. The pane store persists and merges it. */
function useRetarget(tabId: string, environmentId: string) {
  const updateTabBrowserUrl = usePaneLayoutStore((state) => state.updateTabBrowserUrl);
  return useCallback(
    (value: string) => updateTabBrowserUrl(tabId, value, environmentId, [], -1),
    [environmentId, tabId, updateTabBrowserUrl],
  );
}

function ServicePreview({
  tabId,
  environmentId,
  isActive,
  refreshRequestId = 0,
  serviceRef,
}: ServiceBrowserTabProps & { serviceRef: PreviewServiceRef }) {
  const { capabilities, status, services, snapshotLoaded, refreshEnvironment } =
    useEnvironmentServices(serviceRef.environmentId, isActive);
  const retarget = useRetarget(tabId, environmentId);
  const environment = useEnvironmentStore((state) => state.getEnvironmentById(environmentId));
  const nativeSessionCount = usePaneLayoutStore((state) => {
    const layout = state.environments.get(environmentId);
    if (!layout) return 0;
    return getAllLeaves(layout.root).reduce(
      (count, leaf) => count + leaf.tabs.filter((tab) => tab.type === "agent-native").length,
      0,
    );
  });
  const service =
    services.find((candidate) => candidate.definition.serviceId === serviceRef.serviceId) ?? null;
  const nativeBrowserPreview = hasNativeBrowserPreview();
  const [path, setPath] = useState(serviceRef.path);
  const [address, setAddress] = useState("");
  const [nativeState, setNativeState] = useState<BrowserPreviewState | null>(null);
  const [transport, setTransport] = useState<BrowserPreviewTransportState | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachNonce, setAttachNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | "register" | "edit" | "settings">(null);
  const [iframeRevision, setIframeRevision] = useState(0);
  const locallyPersistedPath = useRef<string | null>(null);
  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const nativeAttachedRef = useRef(false);
  const previousRefresh = useRef(refreshRequestId);
  const hasBlockingOverlay = useBlockingOverlay(nativeBrowserPreview);
  const { annotationMode, annotationSaving, toggleAnnotationMode, stopAnnotationForPageChange } =
    useBrowserPreviewAnnotation({
      tabId,
      environmentId,
      isActive,
      nativeBrowserPreview,
    });

  const backendMismatch =
    capabilities !== null && capabilities.backendInstanceId !== serviceRef.backendInstanceId;
  const mode: Mode = useMemo(() => {
    if (!capabilities) return status === "unsupported" ? "unsupported" : "compatibility";
    if (nativeBrowserPreview) {
      if (capabilities.surfaces.desktopTunnel.available) return "desktop-tunnel";
      return capabilities.surfaces.legacyPath.available ? "compatibility" : "unsupported";
    }
    return capabilities.surfaces.browserTopLevel.available ? "top-level" : "unsupported";
  }, [capabilities, nativeBrowserPreview, status]);

  // Follow the durable path when another client (or an undo) changes it.
  useEffect(() => {
    if (locallyPersistedPath.current === serviceRef.path) {
      locallyPersistedPath.current = null;
      return;
    }
    setPath(serviceRef.path);
  }, [serviceRef.path]);

  const displayUrl = service ? serviceDisplayUrl(service.definition, path) : path;
  useEffect(() => setAddress(displayUrl), [displayUrl]);

  const persistPath = useCallback(
    (nextPath: string) => {
      if (nextPath === serviceRef.path) return;
      locallyPersistedPath.current = nextPath;
      retarget(formatPreviewServiceUri({ ...serviceRef, path: nextPath }));
    },
    [retarget, serviceRef],
  );

  const applyNativeState = useCallback(
    (state: BrowserPreviewState | null) => {
      if (!state || state.tabId !== tabId) return;
      setNativeState(state);
      if (state.transport) setTransport(state.transport);
      if (state.service && state.service.path !== path) {
        setPath(state.service.path);
        persistPath(state.service.path);
      }
    },
    [path, persistPath, tabId],
  );

  useEffect(() => {
    if (!nativeBrowserPreview) return;
    return window.orkestrator?.listen<BrowserPreviewState>(
      "browser-preview-state",
      applyNativeState,
    );
  }, [applyNativeState, nativeBrowserPreview]);

  const attachTarget: BrowserPreviewServiceTarget | null =
    service && !backendMismatch && service.endpoint.state !== "unavailable"
      ? { ...serviceRef, path }
      : null;

  // Compatibility mode: the service identity still selects the *current*
  // backend host port, so recreation and port reassignment are followed.
  const compatibilityUrl = useMemo(() => {
    if (mode !== "compatibility" || !service || service.definition.scheme !== "http") return null;
    const hostPort = service.endpoint.hostPort;
    if (!hostPort || service.endpoint.state !== "available") return null;
    try {
      return resolveBrowserAddress(`http://localhost:${hostPort}${path}`);
    } catch {
      return null;
    }
  }, [mode, path, service]);

  // `attachTarget` is rebuilt every render; only its identity (service and
  // path) should re-run the attach, or every render would re-attach the view.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!nativeBrowserPreview) return;
    let disposed = false;
    const host = previewHostRef.current;
    const hide = () => void setBrowserPreviewVisible(tabId, false).catch(() => undefined);
    const canAttach =
      host &&
      ((mode === "desktop-tunnel" && attachTarget) ||
        (mode === "compatibility" && compatibilityUrl));
    if (!canAttach) {
      hide();
      return () => {
        disposed = true;
      };
    }
    let frame = 0;
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
        const visible = isActive && !hasBlockingOverlay && dialog === null;
        const attach =
          mode === "desktop-tunnel" && attachTarget
            ? attachBrowserPreview({ tabId, service: attachTarget, bounds, visible })
            : attachBrowserPreview({ tabId, url: compatibilityUrl!.iframeUrl, bounds, visible });
        void attach
          .then((state) => {
            if (disposed) return;
            nativeAttachedRef.current = true;
            setAttachError(null);
            applyNativeState(state);
          })
          .catch((error: unknown) => {
            if (disposed) return;
            const preview = previewErrorFromUnknown(error);
            setTransport({
              mode: "desktop-tunnel",
              state: "unavailable",
              failure: preview?.category ?? "internal",
              message: preview?.message,
            });
            setAttachError(preview ? null : errorMessage(error));
            hide();
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
      hide();
    };
  }, [
    applyNativeState,
    attachNonce,
    attachTarget?.serviceId,
    attachTarget?.path,
    compatibilityUrl,
    dialog,
    hasBlockingOverlay,
    isActive,
    mode,
    nativeBrowserPreview,
    tabId,
  ]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  useEffect(() => {
    const changed = refreshRequestId !== previousRefresh.current;
    previousRefresh.current = refreshRequestId;
    if (changed && refreshRequestId > 0 && nativeAttachedRef.current) {
      void reloadBrowserPreview(tabId)
        .then(applyNativeState)
        .catch(() => undefined);
    }
  }, [applyNativeState, refreshRequestId, tabId]);

  const selectService = useCallback(
    (next: PreviewServiceSnapshot) => {
      stopAnnotationForPageChange();
      retarget(
        formatPreviewServiceUri({
          backendInstanceId: capabilities?.backendInstanceId ?? serviceRef.backendInstanceId,
          environmentId: next.definition.environmentId,
          serviceId: next.definition.serviceId,
          path: next.definition.serviceId === serviceRef.serviceId ? path : "/",
        }),
      );
    },
    [capabilities?.backendInstanceId, path, retarget, serviceRef, stopAnnotationForPageChange],
  );

  const submitAddress = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!service) return;
      const parsed = parseServiceAddressInput(address, service.definition);
      if (parsed.kind === "invalid") {
        setAttachError(parsed.message);
        return;
      }
      setAttachError(null);
      if (parsed.kind === "path") {
        stopAnnotationForPageChange();
        setPath(parsed.path);
        persistPath(parsed.path);
        if (mode === "compatibility") setIframeRevision((value) => value + 1);
        return;
      }
      try {
        const resolution = await backend.resolvePreviewTarget({
          intent: {
            url: parsed.url,
            source: "address-bar",
            environmentId: serviceRef.environmentId,
            mode: "service",
          },
        });
        if (resolution.kind === "service") {
          retarget(
            formatPreviewServiceUri({
              ...serviceRef,
              serviceId: resolution.service.definition.serviceId,
              path: resolution.path,
            }),
          );
        } else {
          setAttachError(
            `No registered service listens on that port. Register it from the service menu, or use a manual backend port.`,
          );
        }
      } catch (error) {
        setAttachError(previewErrorFromUnknown(error)?.message ?? errorMessage(error));
      }
    },
    [address, mode, persistPath, retarget, service, serviceRef, stopAnnotationForPageChange],
  );

  const retry = useCallback(async () => {
    setBusy(true);
    try {
      if (service)
        await backend.probePreviewService(service.definition.serviceId).catch(() => undefined);
      await refreshEnvironment(serviceRef.environmentId, { force: true });
      setTransport(null);
      setAttachNonce((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }, [refreshEnvironment, service, serviceRef.environmentId]);

  const openExternally = useCallback(() => {
    // Pre-open synchronously inside the click so popup blockers allow it.
    const opener = nativeBrowserPreview ? null : window.open("about:blank", "_blank");
    void openServiceExternally({ ...serviceRef, path }, { opener }).catch((error: unknown) => {
      toast.error("Could not open the preview", {
        description: previewErrorFromUnknown(error)?.message ?? errorMessage(error),
      });
    });
  }, [nativeBrowserPreview, path, serviceRef]);

  const onAction = useCallback(
    (action: DiagnosisAction) => {
      switch (action) {
        case "retry":
        case "reconnect":
          void retry();
          return;
        case "start-environment":
          setBusy(true);
          void backend
            .startEnvironmentInBackground(environmentId)
            .then(() => toast.success("Starting environment"))
            .catch((error: unknown) =>
              toast.error("Could not start the environment", { description: errorMessage(error) }),
            )
            .finally(() => setBusy(false));
          return;
        case "configure-mapping":
          setDialog("settings");
          return;
        case "choose-service":
          addressInputRef.current?.focus();
          return;
        case "open-top-level":
          openExternally();
          return;
        case "use-relay":
          void retry();
          return;
      }
    },
    [environmentId, openExternally, retry],
  );

  const diagnosis = backendMismatch
    ? {
        severity: "error" as const,
        title: "Different backend",
        detail:
          "This tab was saved against another backend. Choose one of this backend's services.",
        actions: ["choose-service" as const],
      }
    : snapshotLoaded || status === "error"
      ? diagnoseService(service, { transport, capabilities, backendOnline: status !== "error" })
      : null;

  const readiness = service ? serviceReadiness(service) : null;
  const loading = Boolean(nativeState?.loading) && mode === "desktop-tunnel";
  const canNavigate = nativeAttachedRef.current && nativeBrowserPreview;
  const serviceTarget: BrowserPreviewServiceTarget = { ...serviceRef, path };

  return (
    <div
      className={cn(
        "@container/browser absolute inset-0 flex min-w-0 flex-col overflow-hidden bg-background",
        !isActive && "hidden",
      )}
    >
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-border/80 bg-muted/25 px-2 py-1.5 @md/browser:flex-nowrap">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Back"
          disabled={!nativeState?.canGoBack}
          onClick={() =>
            void goBackBrowserPreview(tabId)
              .then(applyNativeState)
              .catch(() => undefined)
          }
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Forward"
          disabled={!nativeState?.canGoForward}
          onClick={() =>
            void goForwardBrowserPreview(tabId)
              .then(applyNativeState)
              .catch(() => undefined)
          }
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Reload preview"
          disabled={!canNavigate && mode !== "compatibility"}
          onClick={() => {
            stopAnnotationForPageChange();
            if (canNavigate)
              void reloadBrowserPreview(tabId)
                .then(applyNativeState)
                .catch(() => undefined);
            else setIframeRevision((value) => value + 1);
          }}
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
        <form
          className="flex w-full min-w-0 basis-full items-center @md/browser:w-auto @md/browser:basis-0 @md/browser:flex-1"
          onSubmit={(event) => void submitAddress(event)}
        >
          <div
            className={cn(
              "flex h-8 min-w-0 flex-1 items-center rounded-md border bg-input-surface shadow-sm transition-colors focus-within:border-primary/60",
              attachError ? "border-destructive/70" : "border-border",
            )}
          >
            <PreviewServicePicker
              services={services}
              selectedServiceId={serviceRef.serviceId}
              onSelect={selectService}
              onRegister={() => setDialog("register")}
              onManual={() => retarget("")}
            />
            <input
              ref={addressInputRef}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent px-2.5 font-mono text-xs text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground"
              aria-label="Browser address"
              aria-invalid={Boolean(attachError)}
              placeholder="/path"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            {loading && (
              <Loader2 className="mr-2 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            )}
          </div>
          <Button type="submit" size="sm" className="ml-1.5 h-8 shrink-0 px-3" disabled={!service}>
            Go
          </Button>
        </form>
        {nativeBrowserPreview && (
          <Button
            type="button"
            variant={annotationMode ? "secondary" : "ghost"}
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-2.5"
            aria-label={annotationMode ? "Stop annotating preview" : "Annotate preview"}
            aria-pressed={annotationMode}
            disabled={!canNavigate || nativeSessionCount === 0 || annotationSaving}
            onClick={toggleAnnotationMode}
          >
            {annotationSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <MessageSquarePlus className="h-4 w-4" />
            )}
            <span className="hidden @lg/browser:inline">
              {annotationMode ? "Annotating" : "Annotate"}
            </span>
          </Button>
        )}
        {nativeBrowserPreview && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label="Open preview DevTools"
            disabled={!canNavigate}
            onClick={() =>
              void openBrowserPreviewDevTools(tabId)
                .then(applyNativeState)
                .catch(() => undefined)
            }
          >
            <Code2 className="h-4 w-4" />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label="Preview options"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem
              disabled={!capabilities?.surfaces.browserTopLevel.available}
              onSelect={openExternally}
              className="gap-2"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open externally
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!service}
              onSelect={() => {
                void navigator.clipboard
                  .writeText(displayUrl)
                  .then(() => toast.success("Copied the application address"));
              }}
              className="gap-2"
            >
              <Link2 className="h-3.5 w-3.5" />
              Copy application address
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!service}
              onSelect={() => setDialog("edit")}
              className="gap-2"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit service…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!nativeBrowserPreview || mode !== "desktop-tunnel"}
              onSelect={() => {
                void resetBrowserPreviewServiceSiteData(serviceTarget)
                  .then(() =>
                    toast.success("Site data cleared", {
                      description: "This service may ask you to sign in again.",
                    }),
                  )
                  .catch((error: unknown) =>
                    toast.error("Could not clear site data", { description: errorMessage(error) }),
                  );
              }}
              className="gap-2"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset this site's data
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <PreviewDiagnostics
        diagnosis={diagnosis}
        service={service}
        transport={transport}
        mode={mode}
        onAction={onAction}
        busy={busy}
      />
      {(attachError || nativeState?.error) && (
        <div
          role="alert"
          className="min-w-0 shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive break-words [overflow-wrap:anywhere]"
        >
          {attachError ?? nativeState?.error}
        </div>
      )}

      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
        {nativeBrowserPreview && (mode === "desktop-tunnel" || compatibilityUrl) ? (
          <div
            ref={previewHostRef}
            data-native-browser-preview={tabId}
            className="absolute inset-0 block h-full w-full bg-background"
          />
        ) : mode === "compatibility" && compatibilityUrl ? (
          <iframe
            key={`${compatibilityUrl.iframeUrl}:${iframeRevision}`}
            src={compatibilityUrl.iframeUrl}
            title="Backend browser preview"
            className="absolute inset-0 block h-full w-full border-0 bg-background"
            sandbox="allow-forms allow-pointer-lock allow-presentation allow-scripts"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="w-full max-w-sm">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-background shadow-sm">
                <Globe2 className="h-6 w-6 text-primary" />
              </div>
              <h2 className="flex items-center justify-center gap-2 text-base font-semibold text-foreground">
                {readiness && <ReadinessDot tone={readiness.tone} />}
                {service ? service.definition.label : "Preview service"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {mode === "top-level"
                  ? "Embedded previews are not supported in this browser yet. Open the service in its own tab; it uses a private preview address on your tailnet."
                  : mode === "unsupported"
                    ? "This client cannot preview services from this backend. Open the Orkestrator desktop app, or ask the operator to enable private preview publication."
                    : "Waiting for the service to become available."}
              </p>
              {mode === "top-level" && service && (
                <Button type="button" className="mt-4 gap-2" onClick={openExternally}>
                  <ExternalLink className="h-4 w-4" />
                  Open {service.definition.label}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {dialog === "register" || dialog === "edit" ? (
        <PreviewServiceDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          environmentId={serviceRef.environmentId}
          environmentType={environment?.environmentType === "local" ? "local" : "containerized"}
          existing={dialog === "edit" ? (service?.definition ?? null) : null}
          onSaved={(definition: PreviewServiceDefinition) => {
            void refreshEnvironment(serviceRef.environmentId, { force: true });
            if (dialog === "register") {
              retarget(
                formatPreviewServiceUri({
                  ...serviceRef,
                  serviceId: definition.serviceId,
                  path: "/",
                }),
              );
            }
          }}
        />
      ) : null}
      {dialog === "settings" && environment && (
        <LazyLoadBoundary
          loadingFallback={<LazyDialogLoadingFallback label="Loading environment settings…" />}
        >
          <LazyEnvironmentSettingsDialog
            open
            onOpenChange={(open) => !open && setDialog(null)}
            environment={environment}
            onUpdate={(updated) =>
              useEnvironmentStore.getState().updateEnvironment(updated.id, updated)
            }
            onRestart={backend.recreateEnvironment}
          />
        </LazyLoadBoundary>
      )}
    </div>
  );
}

/**
 * A link from a terminal or agent that has not been bound to a service yet.
 * The backend interprets it in its source environment; ambiguity produces a
 * choice and an unregistered port produces an explicit registration offer —
 * never a guess based on whichever service happens to own a host port.
 */
function PreviewIntentChooser({
  tabId,
  environmentId,
  isActive,
  target,
}: ServiceBrowserTabProps & { target: Extract<PreviewTabTarget, { kind: "intent" }> }) {
  const retarget = useRetarget(tabId, environmentId);
  const { capabilities, status, services, refreshEnvironment } = useEnvironmentServices(
    target.environmentId,
    isActive,
  );
  const environment = useEnvironmentStore((state) =>
    state.getEnvironmentById(target.environmentId),
  );
  const [resolution, setResolution] = useState<backend.PreviewTargetResolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void usePreviewServiceStore
      .getState()
      .loadCapabilities()
      .then((loaded) => {
        if (cancelled) return;
        if (!loaded) {
          // Older backend: keep the original behaviour for this link.
          if (usePreviewServiceStore.getState().status === "unsupported") retarget(target.url);
          return;
        }
        return backend
          .resolvePreviewTarget({
            intent: { url: target.url, source: target.source, environmentId: target.environmentId },
          })
          .then((result) => {
            if (cancelled) return;
            if (result.kind === "service") {
              retarget(
                formatPreviewServiceUri({
                  backendInstanceId: loaded.backendInstanceId,
                  environmentId: target.environmentId,
                  serviceId: result.service.definition.serviceId,
                  path: result.path,
                }),
              );
            } else if (result.kind === "manual") {
              retarget(target.url);
            } else {
              setResolution(result);
            }
          });
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setError(previewErrorFromUnknown(failure)?.message ?? errorMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [retarget, target.environmentId, target.source, target.url]);

  const bind = (serviceId: string, path: string) =>
    retarget(
      formatPreviewServiceUri({
        backendInstanceId: capabilities!.backendInstanceId,
        environmentId: target.environmentId,
        serviceId,
        path,
      }),
    );

  const path = resolution?.path ?? "/";
  const container = target.source === "container-terminal";
  return (
    <div
      className={cn(
        "absolute inset-0 grid place-items-center overflow-auto bg-background p-6",
        !isActive && "hidden",
      )}
    >
      <div className="w-full max-w-md space-y-3 text-sm">
        <h2 className="text-base font-semibold">Open {target.url}</h2>
        {status === "loading" || (!resolution && !error) ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Resolving the service in this environment…
          </p>
        ) : null}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {resolution?.kind === "choose" && (
          <div className="space-y-2">
            <p className="text-muted-foreground">Several services use this port. Choose one:</p>
            {resolution.candidates.map((candidate) => (
              <Button
                key={candidate.definition.serviceId}
                type="button"
                variant="secondary"
                className="w-full justify-start gap-2"
                onClick={() => bind(candidate.definition.serviceId, path)}
              >
                <ReadinessDot tone={serviceReadiness(candidate).tone} />
                {candidate.definition.label} · {candidate.definition.targetKind}:
                {candidate.definition.applicationPort}
              </Button>
            ))}
          </div>
        )}
        {resolution?.kind === "unregistered" && (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              {container
                ? `Port ${resolution.suggestion.applicationPort} inside this environment's container is not a registered preview service.`
                : `Port ${resolution.suggestion.applicationPort} is not registered for this environment.`}
              {resolution.bindHint
                ? " The server prints 0.0.0.0, which is its bind address, not a reachable host."
                : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => setRegistering(true)}>
                Register port {resolution.suggestion.applicationPort}
              </Button>
              {!container && (
                <Button type="button" variant="secondary" onClick={() => retarget(target.url)}>
                  Open as a backend host port
                </Button>
              )}
            </div>
            {services.length > 0 && (
              <div className="space-y-1 pt-2">
                <p className="text-xs text-muted-foreground">Or open a registered service:</p>
                {services.map((candidate) => (
                  <Button
                    key={candidate.definition.serviceId}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2"
                    onClick={() => bind(candidate.definition.serviceId, "/")}
                  >
                    <ReadinessDot tone={serviceReadiness(candidate).tone} />
                    {candidate.definition.label} · {candidate.definition.applicationPort}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
        {registering && resolution?.kind === "unregistered" && (
          <PreviewServiceDialog
            open
            onOpenChange={setRegistering}
            environmentId={target.environmentId}
            environmentType={environment?.environmentType === "local" ? "local" : "containerized"}
            suggestion={{
              ...resolution.suggestion,
              label: `port ${resolution.suggestion.applicationPort}`,
            }}
            onSaved={(definition) => {
              void refreshEnvironment(target.environmentId, { force: true });
              bind(definition.serviceId, path);
            }}
          />
        )}
      </div>
    </div>
  );
}
