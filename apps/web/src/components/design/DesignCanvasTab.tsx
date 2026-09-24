import "./design.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MousePointer2, X } from "lucide-react";
import type { DesignElement, DesignFrame } from "@orkestrator/protocol/design-canvas";
import type {
  DesignContextReference,
  DesignFailure,
} from "@orkestrator/protocol/design-operations";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { invoke } from "@/lib/native/backend";
import { pendingPreviewFrames, projectedFrames, type DesignIntent } from "@/stores/designStore";
import {
  DesignCanvasContext,
  nextGestureId,
  type DesignCanvasActions,
  type DesignFrameAction,
  type GeometryPatch,
} from "./design-canvas-context";
import { designApi, failureOf } from "./design-client";
import { useDesignCanvas } from "./design-controller";
import { selectionValidity, type DesignSelection } from "./design-selection";
import { loadViewPrefs, saveViewPrefs } from "./design-view-prefs";
import {
  DEFAULT_VIEWPORT,
  boundsOf,
  centerOn,
  clampZoom,
  fitBounds,
  restoreViewport,
  wheelAction,
  zoomAt,
  type DesignViewport,
} from "./design-viewport";
import { planLiveFrames } from "./design-visibility";
import { DesignAgentDialog } from "./DesignAgentDialog";
import { DesignExportDialog } from "./DesignExportDialog";
import { DesignFrameInspector } from "./DesignFrameInspector";
import { DesignFrameView } from "./DesignFrameView";
import { DesignHistoryPanel } from "./DesignHistoryPanel";
import { DesignInspector } from "./DesignInspector";
import { DesignLayerTree } from "./DesignLayerTree";
import {
  DesignConnectionBanner,
  DesignExportIndicator,
  DesignReviewList,
  DesignSaveIndicator,
  DesignUnavailablePanel,
} from "./DesignStatus";
import { DESIGN_SHORTCUTS, DesignToolbar } from "./DesignToolbar";
import type { DesignFrameBridge } from "./frame-bridge";

const NEW_FRAME_HTML =
  "<!doctype html><html><head><style>body{margin:0;font-family:system-ui;padding:48px;background:#fff;color:#18181b}</style></head><body><h1>Your next idea</h1><p>Ask your agent to design here.</p></body></html>";
const NARROW_WIDTH = 640;

function isTextEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"]'))
  );
}

function failureForLane(intents: DesignIntent[], lane: string): DesignFailure | undefined {
  for (let index = intents.length - 1; index >= 0; index--) {
    const intent = intents[index]!;
    if (intent.lane === lane && intent.phase === "settled" && intent.failure) return intent.failure;
  }
  return undefined;
}

export function DesignCanvasTab({
  canvasId,
  environmentId,
  isActive,
  ownsGlobalShortcuts,
  onClose,
}: {
  canvasId: string;
  environmentId: string;
  isActive: boolean;
  ownsGlobalShortcuts: boolean;
  onClose?: () => void;
}) {
  const { controller, projection } = useDesignCanvas(environmentId, canvasId, isActive);
  const prefs = useMemo(() => loadViewPrefs(controller.key), [controller.key]);
  const [viewport, setViewport] = useState<DesignViewport>(prefs.viewport ?? DEFAULT_VIEWPORT);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const restored = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [workspaceWidth, setWorkspaceWidth] = useState(1024);
  const narrow = workspaceWidth < NARROW_WIDTH;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const [selection, setSelection] = useState<DesignSelection | null>(null);
  const [focusedFrame, setFocusedFrame] = useState<string | null>(prefs.frameId ?? null);
  const [mode, setMode] = useState<"inspect" | "preview">("inspect");
  const [layersOpen, setLayersOpen] = useState(prefs.layers ?? true);
  const [layersWidth, setLayersWidth] = useState(prefs.layersWidth ?? 180);
  const [layersMaxWidth, setLayersMaxWidth] = useState(400);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(prefs.history ?? false);
  const [historyFrame, setHistoryFrame] = useState<string | null>(null);
  const [propertiesFrame, setPropertiesFrame] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [agentContext, setAgentContext] = useState<DesignContextReference | null>(null);
  const [renameFrame, setRenameFrame] = useState<{ id: string; value: string } | null>(null);
  const [deleteFrame, setDeleteFrame] = useState<DesignFrame | null>(null);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const [renderedVersion, setRenderedVersion] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const bridges = useRef(new Map<string, DesignFrameBridge>());
  const viewportElement = useRef<HTMLElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const layersToggle = useRef<HTMLButtonElement>(null);
  const layersResize = useRef<{ x: number; width: number } | null>(null);
  const panStart = useRef<{ x: number; y: number; origin: DesignViewport } | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const projectionRef = useRef(projection);
  projectionRef.current = projection;

  const canvas = projection?.canvas ?? null;
  const metas = projection?.workspace?.frames ?? {};
  const frames = useMemo(() => projectedFrames(projection), [projection]);
  const pendingFrames = useMemo(() => pendingPreviewFrames(projection), [projection]);
  const committedById = useMemo(
    () => new Map((canvas?.frames ?? []).map((frame) => [frame.id, frame])),
    [canvas],
  );
  const editable = projection?.snapshot === "current" || projection?.snapshot === "stale";
  const legacy = projection?.legacy ?? false;

  // Persist small view preferences only.
  useEffect(() => {
    saveViewPrefs(controller.key, {
      viewport,
      frameId: focusedFrame,
      layers: layersOpen,
      layersWidth,
      history: historyOpen,
    });
  }, [controller.key, focusedFrame, historyOpen, layersOpen, layersWidth, viewport]);

  // Restore a saved view once frames and size are known; reset if unusable.
  useEffect(() => {
    if (restored.current || !canvas || size.width === 0) return;
    restored.current = true;
    setViewport(restoreViewport(prefs.viewport, canvas.frames, size));
    if (prefs.frameId && !canvas.frames.some((frame) => frame.id === prefs.frameId))
      setFocusedFrame(null);
  }, [canvas, prefs, size]);

  useEffect(() => {
    const target = viewportElement.current;
    const root = workspace.current;
    if (!isActive || !target || !root) return;
    const measure = () => {
      setSize({ width: target.clientWidth, height: target.clientHeight });
      setWorkspaceWidth(root.clientWidth);
      const maximum = Math.max(120, Math.min(400, Math.floor(root.clientWidth * 0.45)));
      setLayersMaxWidth(maximum);
      setLayersWidth((width) => Math.min(width, maximum));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    observer.observe(root);
    return () => observer.disconnect();
  }, [isActive, projection?.snapshot]);

  // Wheel: non-passive only on the active canvas; zoom anchors at the pointer.
  useEffect(() => {
    const target = viewportElement.current;
    if (!isActive || !target) return;
    const wheel = (event: WheelEvent) => {
      if (mode === "preview" && !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const action = wheelAction(event);
      const bounds = target.getBoundingClientRect();
      if (action.kind === "zoom") {
        const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        setViewport((value) => zoomAt(value, anchor, value.zoom * action.factor));
      } else {
        setViewport((value) => ({
          ...value,
          panX: value.panX - action.dx,
          panY: value.panY - action.dy,
        }));
      }
    };
    target.addEventListener("wheel", wheel, { passive: false });
    return () => target.removeEventListener("wheel", wheel);
  }, [isActive, mode, projection?.snapshot]);

  const zoomBy = useCallback(
    (factor: number) =>
      setViewport((value) =>
        zoomAt(value, { x: size.width / 2, y: size.height / 2 }, clampZoom(value.zoom * factor)),
      ),
    [size],
  );
  const fitAll = useCallback(
    () => setViewport(fitBounds(boundsOf(frames), size, { maxZoom: 1 })),
    [frames, size],
  );
  const fitFrame = useCallback(
    (frameId: string) => {
      const frame = frames.find((candidate) => candidate.id === frameId);
      if (frame) setViewport(fitBounds(boundsOf([frame]), size, { maxZoom: 1.5 }));
    },
    [frames, size],
  );
  const fitSelection = useCallback(() => {
    const current = selectionRef.current;
    const frame = current
      ? frames.find((candidate) => candidate.id === current.frameId)
      : undefined;
    if (current && frame) {
      const rect = current.element.rect;
      setViewport(
        fitBounds(
          { x: frame.x + rect.x, y: frame.y + rect.y, width: rect.width, height: rect.height },
          size,
          {
            maxZoom: 2,
            padding: 96,
          },
        ),
      );
    } else if (focusedFrame) fitFrame(focusedFrame);
  }, [fitFrame, focusedFrame, frames, size]);
  const zoom100 = useCallback(() => {
    const center = {
      x: (size.width / 2 - viewportRef.current.panX) / viewportRef.current.zoom,
      y: (size.height / 2 - viewportRef.current.panY) / viewportRef.current.zoom,
    };
    setViewport(centerOn(center, size, 1));
  }, [size]);

  const plan = useMemo(
    () =>
      planLiveFrames({
        frames,
        viewport,
        size: size.width ? size : { width: 1024, height: 768 },
        pinned,
        selected: selection?.frameId ?? null,
        focused: focusedFrame,
      }),
    [focusedFrame, frames, pinned, selection?.frameId, size, viewport],
  );

  const reportError = useCallback((error: unknown) => {
    setLocalError(failureOf(error).message);
  }, []);

  const submitGeometry = useCallback(
    (base: DesignFrame, patch: GeometryPatch, gestureId: string, label: string) => {
      controller.submit({
        descriptor: {
          input: { kind: "update_frame", frameId: base.id, patch },
          preconditions: { frameRevision: base.revision },
          gestureId,
        },
        label,
        preview: { frameId: base.id, patch },
        gestureKey: `${gestureId}:update_frame`,
      });
    },
    [controller],
  );

  const applyStyles = useCallback(
    (target: DesignSelection, styles: Record<string, string | null>, gestureId?: string) => {
      const current = projectionRef.current;
      const frame = current?.canvas?.frames.find((candidate) => candidate.id === target.frameId);
      const validity = selectionValidity(target, frame, current?.workspace?.frames[target.frameId]);
      if (validity === "stale" || validity === "missing") {
        setLocalError(
          "The frame changed structurally. Reselect the element; your values were kept.",
        );
        return undefined;
      }
      return controller.submit({
        descriptor: {
          input: {
            kind: "set_element_styles",
            frameId: target.frameId,
            selector: target.element.selector,
            styles,
          },
          preconditions: {
            frameRevision: target.revision,
            ...(target.structureId ? { structureId: target.structureId } : {}),
          },
          ...(gestureId ? { gestureId } : {}),
        },
        label: `Style ${target.element.tag}`,
        ...(gestureId ? { gestureKey: `${gestureId}:styles` } : {}),
      });
    },
    [controller],
  );

  // Re-inspect a structure-stable selection after acknowledged edits or viewport changes.
  const refreshSelection = useCallback((frameId: string) => {
    const current = selectionRef.current;
    const latest = projectionRef.current;
    if (!current || current.frameId !== frameId || !latest?.canvas) return;
    const frame = latest.canvas.frames.find((candidate) => candidate.id === frameId);
    const meta = latest.workspace?.frames[frameId];
    const validity = selectionValidity(current, frame, meta);
    if (validity !== "refresh" && validity !== "current") return;
    const bridge = bridges.current.get(frameId);
    const key = meta?.contentId ?? `revision:${frame?.revision}`;
    if (!bridge || bridge.renderedContentId !== key || !frame) return;
    void bridge
      .ask<DesignElement>({ op: "inspectElement", selector: current.element.selector })
      .then((element) => {
        if (
          bridge.renderedContentId !== key ||
          selectionRef.current?.element.selector !== current.element.selector
        )
          return;
        setSelection({
          frameId,
          revision: frame.revision,
          element,
          ...(meta ? { structureId: meta.structureId, contentId: meta.contentId } : {}),
        });
      })
      .catch(() => undefined);
  }, []);

  const selectedFrame = selection ? committedById.get(selection.frameId) : undefined;
  const selectedMeta = selection ? metas[selection.frameId] : undefined;
  const validity = selection
    ? selectionValidity(selection, selectedFrame, selectedMeta)
    : "current";
  useEffect(() => {
    if (selection && validity === "refresh") refreshSelection(selection.frameId);
  }, [refreshSelection, selection, validity, selectedFrame?.width, selectedFrame?.height]);

  const openAgent = useCallback(
    (
      frameId?: string,
      scope: DesignContextReference["scope"] = "discuss",
      checkpointId?: string,
    ) => {
      const current = projectionRef.current;
      if (!current?.canvas) return;
      const selected = selectionRef.current;
      const targetFrameId = frameId ?? selected?.frameId ?? focusedFrame ?? undefined;
      const frame = targetFrameId
        ? current.canvas.frames.find((candidate) => candidate.id === targetFrameId)
        : undefined;
      const meta = frame ? current.workspace?.frames[frame.id] : undefined;
      const element =
        selected && frame && selected.frameId === frame.id ? selected.element : undefined;
      setAgentContext({
        version: 1,
        canvasId,
        canvasName: current.canvas.name,
        environmentId,
        canvasRevision: current.revision,
        scope,
        ...(checkpointId ? { checkpointId } : {}),
        ...(frame
          ? {
              frameId: frame.id,
              frameName: frame.name,
              frameRevision: frame.revision,
              ...(meta ? { structureId: meta.structureId } : {}),
            }
          : {}),
        ...(element
          ? {
              element: {
                selector: element.selector,
                ...(element.key ? { key: element.key } : {}),
                tag: element.tag,
                label: (
                  element.attributes.id ??
                  element.attributes["aria-label"] ??
                  element.text ??
                  element.tag
                ).slice(0, 80),
              },
            }
          : {}),
      });
    },
    [canvasId, environmentId, focusedFrame],
  );

  const frameAction = useCallback(
    (frameId: string, action: DesignFrameAction) => {
      const current = projectionRef.current;
      const frame = current?.canvas?.frames.find((candidate) => candidate.id === frameId);
      if (!frame || !current) return;
      switch (action) {
        case "rename":
          setRenameFrame({ id: frameId, value: frame.name });
          break;
        case "duplicate":
          controller.submit({
            descriptor: {
              input: { kind: "duplicate_frame", frameId },
              preconditions: { frameRevision: frame.revision, canvasRevision: current.revision },
            },
            label: `Duplicate ${frame.name}`,
            lane: "canvas",
          });
          break;
        case "delete":
          setDeleteFrame(frame);
          break;
        case "ask-agent":
          openAgent(
            frameId,
            current.workspace?.frames[frameId]?.validation.state === "invalid"
              ? "revise"
              : "discuss",
          );
          break;
        case "retry-validation":
          void designApi
            .validate(environmentId, canvasId, frameId)
            .then(() => controller.refresh(), reportError);
          break;
        case "restore-previous":
          setHistoryFrame(frameId);
          setHistoryOpen(true);
          break;
        case "fit":
          fitFrame(frameId);
          break;
        case "properties":
          setPropertiesFrame(frameId);
          setSelection(null);
          if (narrow) setInspectorOpen(true);
          break;
      }
    },
    [canvasId, controller, environmentId, fitFrame, narrow, openAgent, reportError],
  );

  const frameActionRef = useRef(frameAction);
  frameActionRef.current = frameAction;
  const actions = useMemo<DesignCanvasActions>(
    () => ({
      controller,
      environmentId,
      canvasId,
      select: (next) => {
        setSelection(next);
        if (next) {
          setFocusedFrame(next.frameId);
          setPropertiesFrame(null);
          // In a narrow pane the inspector is a drawer: selecting opens it.
          if (narrowRef.current) setInspectorOpen(true);
        }
      },
      submitGeometry,
      submitElementResize: (target, width, height, gestureId) => {
        applyStyles(
          target,
          {
            width: `${width}px`,
            height: `${height}px`,
            "box-sizing": "border-box",
            ...(target.element.styles.display === "inline" ? { display: "inline-block" } : {}),
          },
          gestureId,
        );
      },
      registerBridge: (frameId, bridge) => {
        if (bridge) bridges.current.set(frameId, bridge);
        else bridges.current.delete(frameId);
      },
      frameRendered: (frameId) => {
        setRenderedVersion((value) => value + 1);
        refreshSelection(frameId);
      },
      pin: (frameId, value) =>
        setPinned((current) => {
          const next = new Set(current);
          if (value) next.add(frameId);
          else next.delete(frameId);
          return next;
        }),
      reportError: (error) => reportError(error),
      exitPreview: () => setMode("inspect"),
      // Through a ref so viewport/frame changes don't give every frame new props.
      frameAction: (frameId, action) => frameActionRef.current(frameId, action),
      focusFrame: setFocusedFrame,
    }),
    [
      applyStyles,
      canvasId,
      controller,
      environmentId,
      refreshSelection,
      reportError,
      submitGeometry,
    ],
  );

  const restoreHistory = useCallback(
    (kind: "undo" | "redo") => {
      const current = projectionRef.current;
      if (!current?.canvas) return;
      controller.submit({
        descriptor: {
          input: { kind, scope: "own" },
          preconditions: { canvasRevision: current.revision },
        },
        label: kind === "undo" ? "Undo" : "Redo",
        lane: "canvas",
      });
    },
    [controller],
  );
  const addFrame = useCallback(() => {
    const current = projectionRef.current;
    if (!current?.canvas) return;
    const count = current.canvas.frames.length;
    const right = current.canvas.frames.reduce(
      (max, frame) => Math.max(max, frame.x + frame.width),
      -50,
    );
    controller.submit({
      descriptor: {
        input: {
          kind: "create_frame",
          frame: {
            name: `Frame ${count + 1}`,
            x: right + 50,
            y: 0,
            width: 800,
            height: 600,
            html: NEW_FRAME_HTML,
          },
        },
        preconditions: { canvasRevision: current.revision },
      },
      label: "Add frame",
      lane: "canvas",
    });
  }, [controller]);
  const rename = useCallback(
    (name: string) => {
      const current = projectionRef.current;
      if (!current?.canvas) return;
      controller.submit({
        descriptor: {
          input: { kind: "rename_canvas", name },
          preconditions: { canvasRevision: current.revision },
        },
        label: "Rename design",
        lane: "canvas",
      });
    },
    [controller],
  );
  const download = useCallback(async () => {
    try {
      // Download a committed snapshot and name the revision it contains.
      await controller.refresh();
      const current = controller.projection;
      if (!current.canvas) return;
      const snapshot = current.canvas;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${snapshot.name.replace(/[^a-zA-Z0-9_-]/g, "-")}.orkdes`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setLocalError(null);
      setAnnouncement(`Downloaded revision ${snapshot.revision}`);
    } catch (reason) {
      reportError(reason);
    }
  }, [controller, reportError]);
  const restoreDeleted = useCallback(async () => {
    const tombstone = projectionRef.current?.tombstone;
    if (!tombstone) return;
    try {
      const prepared = await designApi.prepare(environmentId, {
        canvasId,
        input: { kind: "restore_canvas" },
        preconditions: { tombstoneRevision: tombstone.revision },
      });
      const status = await designApi.execute(environmentId, canvasId, prepared.token);
      if (status.failure) setLocalError(status.failure.message);
      await controller.refresh();
    } catch (reason) {
      reportError(reason);
    }
  }, [canvasId, controller, environmentId, reportError]);
  const recoveryCopy = useCallback(async () => {
    const last = projectionRef.current?.canvas;
    if (!last) return;
    try {
      const copy = await invoke<{ id: string; name: string }>("design_import", {
        environmentId,
        document: JSON.stringify({
          ...last,
          name: `${last.name} (recovered r${last.revision})`.slice(0, 120),
        }),
      });
      setAnnouncement(`Saved a recovery copy as “${copy.name}”`);
    } catch (reason) {
      reportError(reason);
    }
  }, [environmentId, reportError]);

  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (projection?.notice) setAnnouncement(projection.notice.text);
  }, [projection?.notice]);

  // Escape priority: gesture (frame-level) → preview → selection → drawers/panels.
  useEffect(() => {
    if (!isActive) return;
    const root = workspace.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const inside = root?.contains(document.activeElement) ?? false;
      const editing = isTextEditingTarget(event.target);
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && !event.altKey && ownsGlobalShortcuts && !editing) {
        const key = event.key.toLowerCase();
        const redo = (key === "z" && event.shiftKey) || (key === "y" && event.ctrlKey);
        const undo = key === "z" && !event.shiftKey;
        const history = projectionRef.current?.workspace?.history;
        if ((undo && history?.canUndo) || (redo && history?.canRedo)) {
          event.preventDefault();
          restoreHistory(undo ? "undo" : "redo");
          return;
        }
        if (key === "0") {
          event.preventDefault();
          zoom100();
          return;
        }
      }
      if (!inside || editing || modifier) return;
      if (event.key === "Escape") {
        if (mode === "preview") setMode("inspect");
        else if (selectionRef.current) setSelection(null);
        else if (propertiesFrame) setPropertiesFrame(null);
        else if (narrow && (layersOpen || inspectorOpen)) {
          setLayersOpen(false);
          setInspectorOpen(false);
          layersToggle.current?.focus();
        } else if (historyOpen) setHistoryOpen(false);
        else return;
        event.preventDefault();
      } else if (event.key === "!" || (event.shiftKey && event.code === "Digit1")) {
        event.preventDefault();
        fitAll();
      } else if (event.key === "@" || (event.shiftKey && event.code === "Digit2")) {
        event.preventDefault();
        fitSelection();
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(1.2);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomBy(1 / 1.2);
      } else if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        setMode((value) => (value === "preview" ? "inspect" : "preview"));
      } else if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    fitAll,
    fitSelection,
    historyOpen,
    inspectorOpen,
    isActive,
    layersOpen,
    mode,
    narrow,
    ownsGlobalShortcuts,
    propertiesFrame,
    restoreHistory,
    zoom100,
    zoomBy,
  ]);

  // Leaving preview refreshes element bounds so hit testing and overlays agree.
  useEffect(() => {
    if (mode === "inspect" && selectionRef.current) refreshSelection(selectionRef.current.frameId);
  }, [mode, refreshSelection]);

  if (!isActive) return null;
  const unavailable =
    projection &&
    (projection.snapshot === "deleted" ||
      projection.snapshot === "missing" ||
      projection.snapshot === "invalid");
  const selectionIntent = selection
    ? [...(projection?.intents ?? [])]
        .reverse()
        .find(
          (intent) =>
            intent.lane === selection.frameId &&
            intent.descriptor.input.kind === "set_element_styles" &&
            (intent.descriptor.input as { selector: string }).selector ===
              selection.element.selector,
        )
    : undefined;
  const propertiesTarget = propertiesFrame
    ? frames.find((frame) => frame.id === propertiesFrame)
    : undefined;
  const showInspector = Boolean(selection || propertiesTarget) && (!narrow || inspectorOpen);
  const showLayers = layersOpen && (!narrow || !showInspector);

  return (
    <DesignCanvasContext.Provider value={actions}>
      <div
        ref={workspace}
        className="design-workspace absolute inset-0 flex min-h-0 flex-col bg-background"
        aria-label="Design canvas"
        data-narrow={narrow || undefined}
      >
        <DesignToolbar
          layersButtonRef={layersToggle}
          projection={projection}
          zoom={viewport.zoom}
          mode={mode}
          narrow={narrow}
          layersOpen={showLayers}
          inspectorOpen={showInspector}
          historyOpen={historyOpen}
          canEdit={Boolean(editable)}
          hasSelection={Boolean(selection || focusedFrame)}
          onToggleLayers={() => {
            setLayersOpen((value) => !value);
            if (narrow) setInspectorOpen(false);
          }}
          onToggleInspector={() => {
            setInspectorOpen((value) => !value);
            setLayersOpen(false);
          }}
          onToggleHistory={() => setHistoryOpen((value) => !value)}
          onZoomIn={() => zoomBy(1.2)}
          onZoomOut={() => zoomBy(1 / 1.2)}
          onZoom100={zoom100}
          onFitAll={fitAll}
          onFitSelection={fitSelection}
          onAddFrame={addFrame}
          onUndo={() => restoreHistory("undo")}
          onRedo={() => restoreHistory("redo")}
          onExport={() => setExportOpen(true)}
          onDownload={() => void download()}
          onToggleMode={() => setMode((value) => (value === "preview" ? "inspect" : "preview"))}
          onRename={rename}
          onAskAgent={() => openAgent()}
          onShortcuts={() => setShortcutsOpen(true)}
        />
        {projection && (
          <DesignConnectionBanner
            projection={projection}
            onRetry={() => void controller.refresh()}
          />
        )}
        {projection && (
          <DesignReviewList
            projection={projection}
            controller={controller}
            onReselect={(intent) => {
              const frameId = intent.lane;
              setSelection(null);
              setFocusedFrame(frameId);
              fitFrame(frameId);
              setAnnouncement("Select the element again to reapply your values");
            }}
          />
        )}
        {localError && (
          <div
            role="alert"
            className="flex items-center gap-2 border-b border-divider px-3 py-1.5 text-xs text-destructive"
          >
            <span className="flex-1">{localError}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setLocalError(null)}>
              <X className="size-3" />
            </button>
          </div>
        )}
        {mode === "preview" && (
          <div className="flex items-center gap-2 border-b border-divider bg-primary/10 px-3 py-1 text-xs">
            <span className="flex-1">
              Preview: scroll and hover the mockup. Links and forms are inert; scripts never run.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              onClick={() => setMode("inspect")}
            >
              Exit preview
            </Button>
          </div>
        )}
        <p className="sr-only" aria-live="polite" role="status">
          {announcement}
        </p>
        {unavailable && projection ? (
          <DesignUnavailablePanel
            projection={projection}
            onClose={onClose}
            onRestore={() => void restoreDeleted()}
            onRecoveryCopy={() => void recoveryCopy()}
          />
        ) : (
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            {showLayers && (
              <div
                className="design-hierarchy relative flex shrink-0 bg-background"
                style={{ width: layersWidth, maxWidth: layersMaxWidth }}
              >
                <DesignLayerTree
                  environmentId={environmentId}
                  canvasId={canvasId}
                  frames={frames}
                  metas={metas}
                  legacy={legacy}
                  getBridge={(frameId) => bridges.current.get(frameId)}
                  liveFrames={plan.live}
                  pendingFrames={pendingFrames}
                  renderedVersion={renderedVersion}
                  selection={selection}
                  focusedFrameId={focusedFrame}
                  onFocusFrame={(frameId) => {
                    setFocusedFrame(frameId);
                    fitFrame(frameId);
                  }}
                  onSelectElement={(frameId, selector) => {
                    const bridge = bridges.current.get(frameId);
                    const frame = committedById.get(frameId);
                    const meta = metas[frameId];
                    const key = meta?.contentId ?? `revision:${frame?.revision}`;
                    if (!frame) return;
                    if (!bridge || bridge.renderedContentId !== key) {
                      // Bring the frame into view first; hit testing needs a live, current render.
                      setFocusedFrame(frameId);
                      fitFrame(frameId);
                      return;
                    }
                    void bridge
                      .ask<DesignElement>({ op: "inspectElement", selector })
                      .then((element) => {
                        if (bridge.renderedContentId !== key) return;
                        actions.select({
                          frameId,
                          revision: frame.revision,
                          element,
                          ...(meta
                            ? { structureId: meta.structureId, contentId: meta.contentId }
                            : {}),
                        });
                        if (narrow) setInspectorOpen(true);
                      })
                      .catch(reportError);
                  }}
                  onFrameAction={frameAction}
                />
                <div
                  role="separator"
                  aria-label="Resize design hierarchy"
                  aria-orientation="vertical"
                  aria-valuemin={120}
                  aria-valuemax={layersMaxWidth}
                  aria-valuenow={layersWidth}
                  tabIndex={0}
                  className="relative z-30 w-px shrink-0 cursor-col-resize touch-none bg-divider after:absolute after:inset-y-0 after:-left-1 after:w-2 hover:bg-primary/50 focus-visible:bg-primary/50 focus-visible:outline-none"
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    layersResize.current = {
                      x: event.clientX,
                      width: event.currentTarget.parentElement!.getBoundingClientRect().width,
                    };
                  }}
                  onPointerMove={(event) => {
                    const start = layersResize.current;
                    if (!start) return;
                    setLayersWidth(
                      Math.max(
                        120,
                        Math.min(layersMaxWidth, start.width + event.clientX - start.x),
                      ),
                    );
                  }}
                  onPointerUp={(event) => {
                    layersResize.current = null;
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }}
                  onLostPointerCapture={() => {
                    layersResize.current = null;
                  }}
                  onPointerCancel={() => {
                    layersResize.current = null;
                  }}
                  onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const width = event.currentTarget.parentElement!.getBoundingClientRect().width;
                    setLayersWidth(
                      event.key === "Home"
                        ? 120
                        : event.key === "End"
                          ? layersMaxWidth
                          : Math.max(
                              120,
                              Math.min(
                                layersMaxWidth,
                                width + (event.key === "ArrowRight" ? 10 : -10),
                              ),
                            ),
                    );
                  }}
                />
              </div>
            )}
            <main
              ref={viewportElement}
              aria-label="Canvas viewport"
              className="relative min-w-0 flex-1 overflow-hidden bg-muted/40 touch-none"
              style={{
                backgroundImage: "radial-gradient(var(--muted-foreground) .6px, transparent .6px)",
                backgroundSize: "20px 20px",
                backgroundPosition: `${viewport.panX}px ${viewport.panY}px`,
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget && event.button !== 1) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                panStart.current = {
                  x: event.clientX,
                  y: event.clientY,
                  origin: viewportRef.current,
                };
                if (event.button === 0) setSelection(null);
              }}
              onPointerMove={(event) => {
                const start = panStart.current;
                if (start)
                  setViewport({
                    ...start.origin,
                    panX: start.origin.panX + event.clientX - start.x,
                    panY: start.origin.panY + event.clientY - start.y,
                  });
              }}
              onPointerUp={() => {
                panStart.current = null;
              }}
              onPointerCancel={() => {
                panStart.current = null;
              }}
            >
              {canvas?.frames.length === 0 && (
                <div className="pointer-events-none absolute inset-0 grid place-content-center p-8 text-center">
                  <MousePointer2 className="mx-auto mb-4 size-8 text-muted-foreground" />
                  <p className="font-medium">A blank canvas for your next idea</p>
                  <p className="mt-2 max-w-xs text-sm text-muted-foreground">
                    Ask Claude or Codex to review your repo and create a mockup, or add a frame
                    above.
                  </p>
                </div>
              )}
              <div
                style={{
                  position: "absolute",
                  transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`,
                  transformOrigin: "0 0",
                }}
              >
                {frames.map((frame) => {
                  const committed = committedById.get(frame.id) ?? frame;
                  if (
                    !plan.visible.has(frame.id) &&
                    !pinned.has(frame.id) &&
                    selection?.frameId !== frame.id
                  )
                    return (
                      <section
                        key={frame.id}
                        aria-label={`Frame ${frame.name} (offscreen)`}
                        className="absolute"
                        style={{
                          left: frame.x,
                          top: frame.y,
                          width: frame.width,
                          height: frame.height,
                        }}
                      />
                    );
                  return (
                    <DesignFrameView
                      key={frame.id}
                      frame={frame}
                      committed={committed}
                      meta={metas[frame.id]}
                      live={plan.live.has(frame.id)}
                      zoom={viewport.zoom}
                      mode={mode}
                      selected={selection?.frameId === frame.id ? selection : null}
                      pending={pendingFrames.has(frame.id)}
                      failure={failureForLane(projection?.intents ?? [], frame.id)}
                      canRestorePrevious={!legacy}
                      focused={focusedFrame === frame.id}
                    />
                  );
                })}
              </div>
            </main>
            {showInspector && selection && (
              <DesignInspector
                key={`${selection.frameId}:${selection.element.selector}`}
                environmentKey={controller.key}
                selection={selection}
                validity={validity}
                frame={selectedFrame}
                meta={selectedMeta}
                bridge={bridges.current.get(selection.frameId)}
                legacy={legacy}
                status={{
                  pending: Boolean(selectionIntent && selectionIntent.phase !== "settled"),
                  failure:
                    selectionIntent?.phase === "settled" ? selectionIntent.failure : undefined,
                  unchanged:
                    selectionIntent?.outcome === "no-op"
                      ? selectionIntent.result?.unchangedProperties
                      : undefined,
                }}
                onApply={(styles) => applyStyles(selection, styles)}
                onReselect={() => {
                  setSelection(null);
                  setAnnouncement("Select the element again; your draft values are kept");
                }}
                onClose={() => setSelection(null)}
                onAskAgent={() => openAgent(selection.frameId, "revise")}
              />
            )}
            {showInspector && !selection && propertiesTarget && (
              <DesignFrameInspector
                frame={propertiesTarget}
                committed={committedById.get(propertiesTarget.id) ?? propertiesTarget}
                onSubmit={(patch, label) =>
                  submitGeometry(
                    committedById.get(propertiesTarget.id) ?? propertiesTarget,
                    patch,
                    nextGestureId("fields"),
                    label,
                  )
                }
                onClose={() => setPropertiesFrame(null)}
              />
            )}
            {historyOpen && projection && (
              <DesignHistoryPanel
                controller={controller}
                projection={projection}
                environmentId={environmentId}
                canvasId={canvasId}
                focusFrameId={historyFrame}
                onClose={() => {
                  setHistoryOpen(false);
                  setHistoryFrame(null);
                }}
                onUseAsReference={(checkpointId: string) =>
                  openAgent(undefined, "implement", checkpointId)
                }
              />
            )}
          </div>
        )}
        <footer className="flex flex-wrap gap-3 border-t border-divider px-3 py-1 text-[10px] text-muted-foreground">
          <DesignSaveIndicator projection={projection} />
          <DesignExportIndicator projection={projection} />
          <span className="ml-auto" title="Canvas revision">
            {canvas ? `Revision ${canvas.revision}` : "Connecting"}
          </span>
        </footer>
        {projection && (
          <DesignExportDialog
            open={exportOpen}
            onOpenChange={setExportOpen}
            controller={controller}
            projection={projection}
          />
        )}
        <DesignAgentDialog
          context={agentContext}
          projection={projection}
          onLinksChanged={() => void controller.refresh()}
          onOpenChange={(open) => {
            if (!open) setAgentContext(null);
          }}
        />
        <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Design keyboard shortcuts</DialogTitle>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {DESIGN_SHORTCUTS.map(([keys, description]) => (
                <div key={keys} className="contents">
                  <dt className="font-mono text-xs">{keys}</dt>
                  <dd className="text-muted-foreground">{description}</dd>
                </div>
              ))}
            </dl>
          </DialogContent>
        </Dialog>
        <Dialog open={Boolean(renameFrame)} onOpenChange={(open) => !open && setRenameFrame(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Rename frame</DialogTitle>
            </DialogHeader>
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const target = renameFrame && committedById.get(renameFrame.id);
                const name = renameFrame?.value.trim() ?? "";
                if (!target || !name || name.length > 120) return;
                if (name !== target.name)
                  submitGeometry(
                    target,
                    { name },
                    nextGestureId("rename"),
                    `Rename ${target.name}`,
                  );
                setRenameFrame(null);
              }}
            >
              <Input
                autoFocus
                aria-label="Frame name"
                maxLength={120}
                value={renameFrame?.value ?? ""}
                aria-invalid={!renameFrame?.value.trim()}
                onChange={(event) =>
                  setRenameFrame((value) =>
                    value ? { ...value, value: event.target.value } : value,
                  )
                }
              />
              <Button type="submit" disabled={!renameFrame?.value.trim()}>
                Rename
              </Button>
            </form>
          </DialogContent>
        </Dialog>
        <AlertDialog
          open={Boolean(deleteFrame)}
          onOpenChange={(open) => !open && setDeleteFrame(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{deleteFrame?.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                The frame is removed from this design. You can undo it or restore it from history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const target = deleteFrame;
                  const current = projectionRef.current;
                  if (!target || !current) return;
                  controller.submit({
                    descriptor: {
                      input: { kind: "delete_frame", frameId: target.id },
                      preconditions: {
                        frameRevision: target.revision,
                        canvasRevision: current.revision,
                      },
                    },
                    label: `Delete ${target.name}`,
                    lane: "canvas",
                  });
                  if (selectionRef.current?.frameId === target.id) setSelection(null);
                  setDeleteFrame(null);
                }}
              >
                Delete frame
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DesignCanvasContext.Provider>
  );
}
