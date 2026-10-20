import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ExternalLink, Maximize, PanelRight, Rows3, RotateCcw, Square, X } from "lucide-react";
import type {
  ArtifactHostBounds,
  ArtifactHostEvent,
} from "@orkestrator/protocol/artifact-host-ipc";
import { openInBrowser } from "@/lib/backend";
import { getArtifactHostApi } from "@/lib/native/artifact-host";
import {
  prefersReducedMotion,
  readArtifactThemeTokens,
  useAppAppearance,
} from "@/lib/chat/artifact-theme";
import { ARTIFACT_FRAME_CHANNEL } from "@orkestrator/protocol/artifact-frame-channel";
import { useTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import { useBlockingOverlay } from "@/components/browser/browser-tab-hooks";
import {
  LIVE_HOST_INVALIDATION_REASONS,
  liveHostScopeInvalidation,
  useArtifactLiveHostStore,
  type LiveHostSession,
  type LivePlacement,
} from "@/stores/artifactLiveHostStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArtifactLiveHostFrame } from "./ArtifactLiveHostFrame";

/**
 * The window's single live interactive-artifact host, mounted once at the
 * app root (outside Virtuoso). It renders one persistent surface whose DOM
 * parent never changes: placement only changes its fixed-position geometry
 * (over the transcript placeholder, a side panel, or full screen), so the
 * running document is never reparented or reloaded.
 *
 * Desktop: the document runs in the main process's sandboxed
 * WebContentsView; this surface only positions it and relays presentation
 * events. Browser: an opaque-origin sandboxed iframe (ArtifactLiveHostFrame).
 */

export const LIVE_CHROME_HEIGHT = 32;

const ACTIVE_FRAME_PHASES = new Set(["opening", "loading", "ready"]);

/** Every ancestor that clips its content (scroll containers and overflow-hidden boxes). */
function clippingAncestors(element: HTMLElement | null): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (let current = element?.parentElement ?? null; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflowY}${style.overflowX}`))
      result.push(current);
  }
  return result;
}

/**
 * The visible vertical band of the placeholder: the intersection of the window
 * and every clipping ancestor. Using only the nearest ancestor would stop at
 * the card's own frame and let the live document paint over app chrome.
 */
function visibleBand(ancestors: readonly HTMLElement[]): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (const ancestor of ancestors) {
    const bounds = ancestor.getBoundingClientRect();
    top = Math.max(top, bounds.top);
    bottom = Math.min(bottom, bounds.bottom);
  }
  return { top, bottom };
}

interface InlineGeometry {
  rect: { left: number; top: number; width: number; height: number } | null;
  clip: { top: number; bottom: number } | null;
  fullyVisible: boolean;
}

const DETACHED_GEOMETRY: InlineGeometry = { rect: null, clip: null, fullyVisible: false };

/** Track the inline placeholder's viewport rect (ResizeObserver + scroll + resize). */
function useInlineGeometry(anchor: HTMLElement | null, enabled: boolean): InlineGeometry {
  const [geometry, setGeometry] = useState<InlineGeometry>({
    rect: null,
    clip: null,
    fullyVisible: false,
  });
  useLayoutEffect(() => {
    if (!enabled || !anchor) return;
    const ancestors = clippingAncestors(anchor);
    let frame = 0;
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      const bounds = visibleBand(ancestors);
      const clipTop = Math.max(0, bounds.top - rect.top);
      const clipBottom = Math.max(0, rect.bottom - bounds.bottom);
      const hidden = clipTop + clipBottom >= rect.height || rect.width <= 0;
      setGeometry({
        rect: hidden
          ? null
          : { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        clip: clipTop > 0 || clipBottom > 0 ? { top: clipTop, bottom: clipBottom } : null,
        fullyVisible: !hidden && clipTop === 0 && clipBottom === 0,
      });
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(anchor);
    for (const ancestor of ancestors) observer?.observe(ancestor);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [anchor, enabled]);
  // A disabled or detached placeholder reports no geometry; stale measurements are ignored.
  return enabled && anchor ? geometry : DETACHED_GEOMETRY;
}

function surfaceStyle(placement: LivePlacement, inline: InlineGeometry): CSSProperties {
  switch (placement) {
    case "fullscreen":
      return { top: "var(--desktop-title-bar-height, 0px)", left: 0, right: 0, bottom: 0 };
    case "panel":
      return {
        right: 16,
        bottom: 16,
        width: "min(560px, calc(100vw - 2rem))",
        height: "min(70vh, 720px)",
      };
    case "inline":
      if (!inline.rect) {
        // Off-screen but alive: the same document keeps running while its row is virtualized away.
        return {
          left: -10_000,
          top: 0,
          width: 1,
          height: 1,
          visibility: "hidden",
          pointerEvents: "none",
        };
      }
      return {
        left: inline.rect.left,
        top: inline.rect.top,
        width: inline.rect.width,
        height: inline.rect.height,
        ...(inline.clip
          ? { clipPath: `inset(${inline.clip.top}px 0 ${inline.clip.bottom}px 0)` }
          : {}),
      };
  }
}

const PHASE_TEXT: Record<LiveHostSession["phase"], string> = {
  opening: "Starting…",
  loading: "Loading…",
  ready: "Running",
  crashed: "Stopped: the interactive view crashed",
  unresponsive: "Stopped: the interactive view is not responding",
  "navigation-blocked": "Stopped: navigation was blocked",
  error: "Could not start",
};

function environmentScopeSnapshot() {
  const environments = useEnvironmentStore.getState();
  const ui = useUIStore.getState();
  return {
    environmentIds: new Set(environments.environments.map((environment) => environment.id)),
    deletingIds: environments.deletingEnvironments,
    selectedEnvironmentId: ui.selectedEnvironmentId,
    selectedEnvironmentIds: ui.selectedEnvironmentIds,
  };
}

/**
 * Dispose the live view when its conversation's environment is deleted or
 * the user switches the active environment away from it. The saved preview
 * is shown in the transcript card with the reason.
 */
function useLiveHostScopeGuard(): void {
  useEffect(() => {
    let previous = environmentScopeSnapshot();
    const check = () => {
      const next = environmentScopeSnapshot();
      const active = useArtifactLiveHostStore.getState().active;
      const reason = active
        ? liveHostScopeInvalidation(active.target.scope.environmentId, previous, next)
        : null;
      previous = next;
      if (reason) useArtifactLiveHostStore.getState().invalidate(reason);
    };
    const offEnvironments = useEnvironmentStore.subscribe(check);
    const offUi = useUIStore.subscribe(check);
    return () => {
      offEnvironments();
      offUi();
    };
  }, []);
}

export function ArtifactLiveHost() {
  useLiveHostScopeGuard();
  const active = useArtifactLiveHostStore((state) => state.active);
  const pendingSwitch = useArtifactLiveHostStore((state) => state.pendingSwitch);
  const confirmSwitch = useArtifactLiveHostStore((state) => state.confirmSwitch);
  const cancelSwitch = useArtifactLiveHostStore((state) => state.cancelSwitch);

  return (
    <>
      {active ? <LiveHostSurface key={active.hostId} active={active} /> : null}
      {pendingSwitch && active ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : cancelSwitch())}>
          <DialogContent className="sm:max-w-md" data-artifact-live-switch="true">
            <DialogTitle>Switch interactive artifact?</DialogTitle>
            <DialogDescription>
              Only one interactive artifact runs per window. Stop “{active.target.title}” and run “
              {pendingSwitch.title}”? Stopping closes only the view; nothing is deleted.
            </DialogDescription>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={cancelSwitch}>
                Keep current
              </Button>
              <Button onClick={confirmSwitch}>Switch</Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function LiveHostSurface({ active }: { active: LiveHostSession }) {
  const { hostId, target, phase, session, placement, linkRequest } = active;
  const anchor = useArtifactLiveHostStore(
    (state) => state.anchors.get(target.occurrenceKey) ?? null,
  );
  const setPlacement = useArtifactLiveHostStore((state) => state.setPlacement);
  const stop = useArtifactLiveHostStore((state) => state.stop);
  const invalidate = useArtifactLiveHostStore((state) => state.invalidate);
  const reset = useArtifactLiveHostStore((state) => state.reset);
  const reportStore = useArtifactLiveHostStore((state) => state.report);
  const report = useCallback(
    (patch: Parameters<typeof reportStore>[1]) => reportStore(hostId, patch),
    [hostId, reportStore],
  );
  const appearance = useAppAppearance();
  const capabilities = useTranscriptArtifactCapabilities();
  // A backend switch invalidates the channel: this view belongs to the old backend.
  useEffect(() => {
    if (capabilities && capabilities.backendId !== target.scope.backendId) {
      invalidate(LIVE_HOST_INVALIDATION_REASONS.backendChanged);
    }
  }, [capabilities, invalidate, target.scope.backendId]);
  const inline = useInlineGeometry(anchor, placement === "inline");
  const frameAreaRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const api = getArtifactHostApi();
  const blocked = useBlockingOverlay(api !== null);
  const frameActive = ACTIVE_FRAME_PHASES.has(phase);
  const shown = placement !== "inline" || inline.rect !== null;

  useEffect(() => {
    if (placement !== "fullscreen") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlacement("inline");
    };
    window.addEventListener("keydown", onKey);
    surfaceRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [placement, setPlacement]);

  // Desktop: the main process owns the document; this only positions it.
  const appearanceRef = useRef(appearance);
  useLayoutEffect(() => {
    appearanceRef.current = appearance;
  });
  useEffect(() => {
    if (!api || !session || !frameActive) return;
    const area = frameAreaRef.current;
    const rect = area?.getBoundingClientRect();
    const bounds: ArtifactHostBounds = rect
      ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      : { x: 0, y: 0, width: 1, height: 1 };
    const unsubscribe = api.onEvent((event: ArtifactHostEvent) => {
      if (event.hostId !== hostId) return;
      switch (event.type) {
        case "ready":
          report({ phase: "ready", message: null });
          void api.postTheme(hostId, {
            channel: ARTIFACT_FRAME_CHANNEL,
            v: 1,
            type: "theme",
            artifactId: session.artifactId,
            revision: session.revision,
            generation: session.generation,
            appearance: appearanceRef.current,
            reducedMotion: prefersReducedMotion(),
            viewport: { width: Math.round(bounds.width), height: Math.round(bounds.height) },
            tokens: readArtifactThemeTokens(),
          });
          break;
        case "size":
          report({ height: event.height });
          break;
        case "link-request":
          report({
            linkRequest: { href: event.href, hostname: event.hostname, label: event.label },
          });
          break;
        case "navigation-blocked":
          report({
            phase: "navigation-blocked",
            message: "The interactive document tried to navigate and was stopped.",
          });
          break;
        case "crashed":
          report({ phase: "crashed", message: "The interactive view crashed." });
          break;
        case "unresponsive":
          report({ phase: "unresponsive", message: "The interactive view stopped responding." });
          break;
        case "closed":
          if (event.reason !== "requested")
            report({ phase: "crashed", message: "The interactive view was closed." });
          break;
      }
    });
    void api
      .open({
        hostId,
        contentUrl: session.contentUrl,
        artifactId: session.artifactId,
        revision: session.revision,
        generation: session.generation,
        readinessNonce: session.readinessNonce,
        bounds,
        visible: false,
      })
      .then((result) => {
        if (!result.ok) report({ phase: "error", message: result.error.slice(0, 300) });
      })
      .catch(() =>
        report({ phase: "error", message: "The interactive host could not be opened." }),
      );
    return () => {
      unsubscribe();
      void api.close(hostId).catch(() => {});
    };
    // Theme changes are posted separately (below); reopening would reload the document.
  }, [api, frameActive, hostId, report, session]);

  // Desktop: theme changes are presentation-only messages to the same document.
  useEffect(() => {
    if (!api || !session || phase !== "ready") return;
    const rect = frameAreaRef.current?.getBoundingClientRect();
    void api.postTheme(hostId, {
      channel: ARTIFACT_FRAME_CHANNEL,
      v: 1,
      type: "theme",
      artifactId: session.artifactId,
      revision: session.revision,
      generation: session.generation,
      appearance,
      reducedMotion: prefersReducedMotion(),
      viewport: { width: Math.round(rect?.width ?? 0), height: Math.round(rect?.height ?? 0) },
      tokens: readArtifactThemeTokens(),
    });
  }, [api, appearance, hostId, phase, session]);

  // Desktop: keep the native view over the frame area; hide it whenever it would cover other UI.
  useEffect(() => {
    if (!api || !session || !frameActive) return;
    const area = frameAreaRef.current;
    if (!area) return;
    const visible = !blocked && shown && (placement !== "inline" || inline.fullyVisible);
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = area.getBoundingClientRect();
        void api
          .setBounds(hostId, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
          .catch(() => {});
      });
    };
    sync();
    void api.setVisible(hostId, visible).catch(() => {});
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(area);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [api, blocked, frameActive, hostId, inline, placement, session, shown]);

  const style = surfaceStyle(placement, inline);
  return (
    <div
      ref={surfaceRef}
      tabIndex={-1}
      role="region"
      aria-label={`Interactive artifact: ${target.title}`}
      data-artifact-live-host={hostId}
      data-placement={placement}
      data-artifact-live-occurrence={target.occurrenceKey}
      style={style}
      className={cn(
        "fixed flex flex-col overflow-hidden border border-border bg-background text-xs shadow-xl outline-none",
        placement === "inline"
          ? "z-[40] rounded-md"
          : placement === "panel"
            ? "z-[45] rounded-lg"
            : "z-[60]",
      )}
    >
      <div
        data-rich-chrome="true"
        className="flex shrink-0 select-none items-center gap-1.5 border-b border-border px-2"
        style={{ height: LIVE_CHROME_HEIGHT }}
      >
        <span className="min-w-0 truncate font-medium">{target.title}</span>
        <span className="shrink-0 text-muted-foreground">
          Interactive · revision {target.revision}
          {active.sessionNumber > 1 ? ` · new interaction session ${active.sessionNumber}` : ""}
        </span>
        <span
          aria-live="polite"
          className="shrink-0 text-muted-foreground"
          data-artifact-live-phase={phase}
        >
          · {PHASE_TEXT[phase]}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {linkRequest ? (
            <span
              className="flex items-center gap-0.5 rounded border border-border px-1"
              data-artifact-link-request="true"
            >
              <button
                type="button"
                className="inline-flex items-center gap-1 underline"
                title={`${linkRequest.label ? `${linkRequest.label} — ` : ""}${linkRequest.href}`}
                onClick={() => {
                  const href = linkRequest.href;
                  report({ linkRequest: null });
                  void openInBrowser(href).catch(() => {});
                }}
              >
                <ExternalLink aria-hidden="true" className="size-3" />
                Open {linkRequest.hostname}
              </button>
              <button
                type="button"
                aria-label="Dismiss link request"
                onClick={() => report({ linkRequest: null })}
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </span>
          ) : null}
          <PlacementButton
            current={placement}
            value="inline"
            label="Show inline"
            onSelect={setPlacement}
            icon={<Rows3 aria-hidden="true" className="size-3.5" />}
          />
          <PlacementButton
            current={placement}
            value="panel"
            label="Show in panel"
            onSelect={setPlacement}
            icon={<PanelRight aria-hidden="true" className="size-3.5" />}
          />
          <PlacementButton
            current={placement}
            value="fullscreen"
            label="Full screen"
            onSelect={setPlacement}
            icon={<Maximize aria-hidden="true" className="size-3.5" />}
          />
          <button
            type="button"
            aria-label="Stop interactive view"
            title="Stop: closes this view only"
            onClick={stop}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-foreground hover:bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Square aria-hidden="true" className="size-3" /> Stop
          </button>
        </span>
      </div>
      <div
        ref={frameAreaRef}
        className="relative min-h-0 flex-1"
        data-artifact-live-frame-area="true"
      >
        {!api && session && frameActive ? (
          <ArtifactLiveHostFrame
            session={session}
            title={target.title}
            appearance={appearance}
            report={report}
          />
        ) : null}
        {!frameActive || phase === "opening" ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/90 p-3 text-center"
            data-artifact-live-fallback={phase}
          >
            {target.previewDataUrl ? (
              <img
                src={target.previewDataUrl}
                alt={`Saved preview of ${target.title}`}
                className="max-h-[60%] max-w-full rounded border border-border opacity-70"
              />
            ) : null}
            <p>{active.message ?? PHASE_TEXT[phase]}</p>
            {!frameActive ? (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={reset}>
                  <RotateCcw aria-hidden="true" className="size-3" /> Reset (new interaction
                  session)
                </Button>
                <Button size="sm" variant="ghost" onClick={stop}>
                  Close
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PlacementButton({
  current,
  value,
  label,
  icon,
  onSelect,
}: {
  current: LivePlacement;
  value: LivePlacement;
  label: string;
  icon: ReactNode;
  onSelect: (placement: LivePlacement) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={current === value}
      onClick={() => onSelect(value)}
      className={cn(
        "inline-flex h-6 min-w-6 items-center justify-center rounded text-muted-foreground hover:bg-elevated hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
        current === value && "bg-elevated text-foreground",
      )}
    >
      {icon}
    </button>
  );
}

/**
 * The transcript-side placeholder for the active occurrence. It reserves the
 * live surface's inline height and registers itself as the anchor; the host
 * draws the document over it. It never owns the document.
 */
export function ArtifactLivePlaceholder({ occurrenceKey }: { occurrenceKey: string }) {
  const registerAnchor = useArtifactLiveHostStore((state) => state.registerAnchor);
  const placement = useArtifactLiveHostStore((state) =>
    state.active?.target.occurrenceKey === occurrenceKey ? state.active.placement : null,
  );
  const frameHeight = useArtifactLiveHostStore((state) =>
    state.active?.target.occurrenceKey === occurrenceKey ? state.active.frameHeight : null,
  );
  const setPlacement = useArtifactLiveHostStore((state) => state.setPlacement);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    return registerAnchor(occurrenceKey, element);
  }, [element, occurrenceKey, registerAnchor]);
  const detached = placement !== null && placement !== "inline";
  return (
    <div
      ref={setElement}
      data-artifact-live-placeholder={
        placement === null ? "idle" : detached ? "detached" : "inline"
      }
      style={
        placement === "inline" && frameHeight !== null
          ? { height: LIVE_CHROME_HEIGHT + frameHeight }
          : undefined
      }
      className={
        detached ? "flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground" : "w-full"
      }
    >
      {detached ? (
        <>
          Running {placement === "panel" ? "in the side panel" : "full screen"}.
          <button type="button" className="underline" onClick={() => setPlacement("inline")}>
            Show inline
          </button>
        </>
      ) : null}
    </div>
  );
}
