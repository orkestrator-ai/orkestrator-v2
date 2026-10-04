import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { DesignCanvas } from "@orkestrator/protocol/design-canvas";
import type { CreatableTabType, CreateTabOptions } from "@/contexts/TerminalContext";
import { MAX_TABS } from "@/contexts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { invoke } from "@/lib/native/backend";
import { pickHostPath } from "@/lib/host-path-picker";
import { createSessionKey } from "@/lib/utils";
import { useConfigStore } from "@/stores";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { createUniqueTabId } from "@/components/terminal/TerminalContainer.helpers";
import {
  classifyTransportError,
  designAction,
  designApi,
  designBackendKey,
  failureOf,
} from "./design-client";
import {
  DESIGN_AGENTS,
  DESIGN_AGENT_LABELS,
  DESIGN_BRIEF_EXAMPLES,
  DESIGN_BRIEF_MAX,
  DESIGN_CONTENT_EXPLANATION,
  DESIGN_FRAME_PRESETS,
  DESIGN_NAME_MAX,
  DesignLaunchError,
  launchDesignWorkspace,
  loadDesignReadiness,
  rendererUnavailable,
  readDesignImport,
  runDesignLifecycle,
  validateDesignName,
  type DesignAgent,
  type DesignFramePresetId,
  type DesignReadinessView,
} from "./design-launch";
import {
  decideDesignOpen,
  designOpenChoices,
  planDesignLaunch,
  type DesignLayoutFacts,
  type DesignPlacement,
} from "./design-open";
import {
  addDesignImagesToDraft,
  DESIGN_PROMPT_IMAGE_HINT,
  DesignPromptImages,
  useDesignPromptImagePaste,
  type DesignPromptImage,
} from "./design-prompt-images";
import { DesignLibrary } from "./DesignLibrary";

export type DesignWorkspaceMode = "new" | "open" | "saved";
type AgentChoice = DesignAgent | "none";
type CreateTab = (type: CreatableTabType, options?: CreateTabOptions) => boolean;

const DEFAULT_ENABLED_AGENTS: readonly string[] = ["claude", "codex", "opencode"];

/** Current layout facts for one environment, read at decision time. */
export function readDesignLayoutFacts(environmentId: string): DesignLayoutFacts {
  const store = usePaneLayoutStore.getState();
  const state = store.environments.get(environmentId);
  const activePaneId = state?.activePaneId;
  return {
    tabs: state ? store.getAllTabs(environmentId) : [],
    maxTabs: MAX_TABS,
    canSplit: Boolean(activePaneId && store.canAddTabInSplit(activePaneId, environmentId)),
    hasCurrentPane: Boolean(state && activePaneId && store.getPane(activePaneId, environmentId)),
  };
}

function focusTab(environmentId: string, tabId: string): boolean {
  const store = usePaneLayoutStore.getState();
  const pane = store.findPaneWithTab(tabId, environmentId);
  if (!pane) return false;
  store.setActivePane(pane.id, environmentId);
  store.setActiveTab(pane.id, tabId, environmentId);
  return true;
}

function removeTab(environmentId: string, tabId: string) {
  const store = usePaneLayoutStore.getState();
  const pane = store.findPaneWithTab(tabId, environmentId);
  if (pane) store.removeTab(pane.id, tabId, environmentId);
}

const errorText = (error: unknown) => failureOf(error).message;

export function DesignWorkspaceDialog({
  open,
  onOpenChange,
  environmentId,
  createTab,
  loadReadiness = loadDesignReadiness,
  initialMode = "new",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  /** null while the environment is not running. */
  createTab: CreateTab | null;
  loadReadiness?: (probe: boolean) => Promise<DesignReadinessView>;
  initialMode?: DesignWorkspaceMode;
}) {
  const backendKey = designBackendKey();
  const scope = `${backendKey}\u0000${environmentId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const [mode, setMode] = useState<DesignWorkspaceMode>(initialMode);
  // The draft lives here, outside the tab panels, so switching modes, closing
  // the dialog, or a failed launch never loses it.
  const [name, setName] = useState("Untitled design");
  const [nameTouched, setNameTouched] = useState(false);
  const [agentChoice, setAgentChoice] = useState<AgentChoice | null>(null);
  const [brief, setBrief] = useState("");
  // Pasted images live in this environment's workspace and travel with the
  // brief as attachments of the agent's first message.
  const [briefImages, setBriefImages] = useState<DesignPromptImage[]>([]);
  const briefRef = useRef<HTMLDivElement>(null);
  const [preset, setPreset] = useState<DesignFramePresetId>("none");
  const [busy, setBusy] = useState(false);
  const [uploadFallback, setUploadFallback] = useState(false);
  const importEpoch = useRef(0);
  useEffect(
    () => () => {
      importEpoch.current++;
    },
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{
    canvasId: string;
    name: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const enabledPlatforms: readonly string[] = useConfigStore(
    (state) => state.config.global.enabledAgentPlatforms ?? DEFAULT_ENABLED_AGENTS,
  );
  const agents = useMemo<Record<DesignAgent, boolean>>(
    () => ({
      claude: enabledPlatforms.includes("claude"),
      codex: enabledPlatforms.includes("codex"),
    }),
    [enabledPlatforms],
  );
  const agent: AgentChoice =
    agentChoice ?? DESIGN_AGENTS.find((candidate) => agents[candidate]) ?? "none";

  // Readiness: probed when the dialog opens and on Retry only.
  const [readiness, setReadiness] = useState<{
    scope: string;
    view: DesignReadinessView | null;
    loading: boolean;
  }>({ scope, view: null, loading: false });
  const readinessEpoch = useRef(0);
  const view = readiness.scope === scope ? readiness.view : null;
  const readinessLoading = readiness.scope === scope ? readiness.loading : true;
  const refreshReadiness = useCallback(() => {
    const epoch = ++readinessEpoch.current;
    const requestScope = scopeRef.current;
    setReadiness((previous) => ({
      scope: requestScope,
      view: previous.scope === requestScope ? previous.view : null,
      loading: true,
    }));
    void loadReadiness(true)
      .then(
        (next) => next,
        (reason): DesignReadinessView => ({
          backend: { state: "failed", message: errorText(reason) },
          protocol: "unknown",
          capabilities: null,
          storage: { state: "unknown" },
          renderer: { state: "unknown", ready: false, message: "" },
        }),
      )
      .then((next) => {
        if (epoch !== readinessEpoch.current || requestScope !== scopeRef.current) return;
        setReadiness({ scope: requestScope, view: next, loading: false });
      });
  }, [loadReadiness]);
  useEffect(() => {
    if (open) refreshReadiness();
  }, [open, scope, refreshReadiness]);
  useEffect(() => {
    importEpoch.current++;
    setBusy(false);
    setUploadFallback(false);
    setError(null);
    setRecovery(null);
    setNotice(null);
    // Images were written into the previous environment's workspace.
    setBriefImages([]);
  }, [scope]);

  // Layout facts follow the pane store so open/focus choices stay current.
  // Subscribing to this environment's layout re-renders on tab/pane changes;
  // the facts themselves are cheap to derive (at most MAX_TABS tabs).
  usePaneLayoutStore((state) => state.environments.get(environmentId));
  const hydrated = usePaneLayoutStore((state) => state.hydration.get(environmentId) === "done");
  const facts = readDesignLayoutFacts(environmentId);
  const environmentReady = Boolean(createTab) && hydrated;
  const legacy = view?.protocol === "v1";
  const withAgent = agent !== "none";
  const plan = planDesignLaunch({ environmentReady, withAgent, facts });
  const nameProblem = validateDesignName(name);
  const readinessBlocked = Boolean(
    view &&
    (view.backend.state !== "connected" ||
      view.storage.state === "unavailable" ||
      rendererUnavailable(view)),
  );
  const createBlocker = !environmentReady
    ? "Start this environment to create or open designs."
    : view && view.backend.state !== "connected"
      ? "Reconnect to the backend before creating a design."
      : view?.storage.state === "unavailable"
        ? "Design storage is unavailable."
        : rendererUnavailable(view)
          ? "Creating a design needs the renderer."
          : withAgent && !agents[agent]
            ? `${DESIGN_AGENT_LABELS[agent]} is disabled in Settings. Choose another agent or a blank canvas.`
            : !plan.ok
              ? plan.message
              : null;

  const imagePaste = useDesignPromptImagePaste({
    containerRef: briefRef,
    environmentId,
    scopeKey: scope,
    enabled: environmentReady && withAgent && open && !busy,
    images: briefImages,
    onImagesChange: setBriefImages,
  });

  const openDesign = useCallback(
    (canvasId: string, placement: DesignPlacement): string | null => {
      const decision = decideDesignOpen(canvasId, placement, readDesignLayoutFacts(environmentId));
      if (decision.kind === "focus") {
        if (!focusTab(environmentId, decision.tabId))
          return "The open design tab could not be focused.";
        onOpenChange(false);
        return null;
      }
      if (decision.kind === "refuse") return decision.message;
      if (!createTab) return "Start this environment to open designs.";
      if (
        !createTab("design-canvas", {
          canvasId,
          designPlacement: decision.placement,
        })
      )
        return "The design could not be opened in this layout. Close a tab or pane and try again.";
      onOpenChange(false);
      return null;
    },
    [createTab, environmentId, onOpenChange],
  );

  const create = async () => {
    setNameTouched(true);
    if (
      busy ||
      nameProblem ||
      createBlocker ||
      !createTab ||
      !plan.ok ||
      !imagePaste.tryBeginSubmission()
    )
      return;
    const launchScope = scopeRef.current;
    const originPaneId = usePaneLayoutStore
      .getState()
      .environments.get(environmentId)?.activePaneId;
    const sessions = view?.protocol === "v2" && view.capabilities?.sessions;
    const images = withAgent ? briefImages : [];
    setBusy(true);
    setError(null);
    setRecovery(null);
    try {
      const result = await launchDesignWorkspace({
        name,
        agent: withAgent ? agent : null,
        brief,
        framePreset: preset,
        placement: plan.placement,
        canvasTabId: createUniqueTabId("design"),
        agentTabId: createUniqueTabId("design-agent"),
        createCanvas: (canvasName) =>
          designAction<DesignCanvas>(environmentId, "create_canvas", {
            name: canvasName,
          }),
        createFrame: (canvas, frame) =>
          designAction<{ canvasRevision: number }>(environmentId, "create_frame", {
            canvasId: canvas.id,
            expectedRevision: canvas.revision,
            x: 0,
            y: 0,
            ...frame,
          }),
        openCanvas: (canvasId, tabId, placement) =>
          createTab("design-canvas", {
            canvasId,
            tabId,
            designPlacement: placement,
          }),
        createAgentTab: (platform, tabId, initialPrompt) => {
          // The agent sits beside the canvas in the pane the user started from.
          if (originPaneId)
            usePaneLayoutStore.getState().setActivePane(originPaneId, environmentId);
          // Seed the images before the tab mounts so the initial prompt,
          // which the tab sends from its draft, carries them.
          const sessionKey = createSessionKey(environmentId, tabId);
          if (!addDesignImagesToDraft(sessionKey, images))
            throw new Error(
              "Too many images for this conversation. Remove some images and try again.",
            );
          let created = false;
          try {
            created = createTab(platform, {
              tabId,
              agentLaunchMode: "native",
              displayTitle: "Design",
              initialPrompt,
            });
            return created;
          } finally {
            const store = usePaneLayoutStore.getState();
            if (!created && images.length > 0 && !store.findPaneWithTab(tabId, environmentId))
              useNativeComposeStore.getState().clearDraft(sessionKey);
          }
        },
        hasTab: (tabId) =>
          Boolean(usePaneLayoutStore.getState().findPaneWithTab(tabId, environmentId)),
        removeTab: (tabId) => removeTab(environmentId, tabId),
        deleteCanvas: (canvasId, revision) =>
          legacy
            ? designAction(environmentId, "delete_canvas", { canvasId })
            : runDesignLifecycle(
                environmentId,
                canvasId,
                { kind: "delete_canvas" },
                {
                  canvasRevision: revision,
                },
              ),
        ...(sessions
          ? {
              linkSession: (canvasId: string, tabId: string, platform: DesignAgent) =>
                designApi.linkSession(environmentId, canvasId, {
                  tabId,
                  platform,
                  role: "design",
                }),
            }
          : {}),
      });
      if (launchScope !== scopeRef.current) return;
      if (result.linkWarning) toast.warning(result.linkWarning);
      setBrief("");
      setBriefImages([]);
      setName("Untitled design");
      setNameTouched(false);
      onOpenChange(false);
    } catch (reason) {
      if (launchScope !== scopeRef.current) return;
      if (reason instanceof DesignLaunchError && reason.recoverable && reason.canvas)
        setRecovery({ canvasId: reason.canvas.id, name: reason.canvas.name });
      setError(errorText(reason));
    } finally {
      imagePaste.endSubmission();
      if (launchScope === scopeRef.current) setBusy(false);
    }
  };

  const finishImport = (imported: DesignCanvas) => {
    const openError = openDesign(imported.id, "split");
    if (!openError) return;
    setNotice(
      `Imported “${imported.name}”${rendererUnavailable(view) ? " — stored unvalidated until the renderer is available" : ""}.`,
    );
    setError(`It could not be opened yet: ${openError}`);
    setRecovery({ canvasId: imported.id, name: imported.name });
  };

  const importFile = async (
    work: () => Promise<DesignCanvas>,
    epoch: number,
    importScope: string,
  ) => {
    const current = () => epoch === importEpoch.current && importScope === scopeRef.current;
    setError(null);
    setNotice(null);
    setRecovery(null);
    try {
      const imported = await work();
      if (current()) finishImport(imported);
    } catch (reason) {
      if (!current()) return;
      if (classifyTransportError(reason) === "unsupported") {
        setUploadFallback(true);
        setError(
          "This backend cannot open host files. Upload an .orkdes file from this device below.",
        );
      } else setError(errorText(reason));
    } finally {
      if (current()) setBusy(false);
    }
  };

  const openFromPicker = async () => {
    if (busy) return;
    const importScope = scopeRef.current;
    const epoch = ++importEpoch.current;
    setBusy(true);
    const path = await pickHostPath({
      mode: "file",
      title: "Open design (.orkdes)",
    });
    if (epoch !== importEpoch.current || importScope !== scopeRef.current) return;
    if (!path) {
      setBusy(false);
      return;
    }
    if (!path.toLowerCase().endsWith(".orkdes")) {
      setError("Choose an .orkdes design file.");
      setBusy(false);
      return;
    }
    await importFile(
      () => invoke<DesignCanvas>("design_import_host_file", { environmentId, path }),
      epoch,
      importScope,
    );
  };

  const uploadFile = async (file: File) => {
    if (busy) return;
    const importScope = scopeRef.current;
    const epoch = ++importEpoch.current;
    setBusy(true);
    await importFile(
      async () => {
        const document = await readDesignImport(file);
        if (epoch !== importEpoch.current || importScope !== scopeRef.current)
          throw new Error("Design workspace changed.");
        return invoke<DesignCanvas>("design_import", { environmentId, document });
      },
      epoch,
      importScope,
    );
  };

  const showNameError = nameTouched && nameProblem;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[min(42rem,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>Design workspace</DialogTitle>
          <DialogDescription>
            Design with Claude or Codex beside a shared HTML canvas, or open an existing .orkdes
            design file.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={(value) => setMode(value as DesignWorkspaceMode)}>
          <TabsList className="w-full">
            <TabsTrigger value="new">New design</TabsTrigger>
            <TabsTrigger value="open">Open design</TabsTrigger>
            <TabsTrigger value="saved">Saved designs</TabsTrigger>
          </TabsList>
          <TabsContent value="new">
            <form
              className="grid gap-3"
              aria-label="New design"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <label className="grid gap-1 text-sm">
                Name
                <Input
                  required
                  maxLength={DESIGN_NAME_MAX}
                  value={name}
                  aria-invalid={showNameError ? true : undefined}
                  aria-describedby={showNameError ? "design-name-error" : undefined}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={() => setNameTouched(true)}
                />
              </label>
              {showNameError && (
                <p id="design-name-error" className="text-xs text-destructive">
                  {nameProblem}
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  Start with
                  <Select
                    value={agent}
                    onValueChange={(value) => setAgentChoice(value as AgentChoice)}
                  >
                    <SelectTrigger aria-label="Design agent" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DESIGN_AGENTS.map((candidate) => (
                        <SelectItem key={candidate} value={candidate} disabled={!agents[candidate]}>
                          {DESIGN_AGENT_LABELS[candidate]}
                          {!agents[candidate] ? " (disabled in Settings)" : ""}
                        </SelectItem>
                      ))}
                      <SelectItem value="none">Blank canvas (no agent)</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1 text-sm">
                  Initial frame
                  <Select
                    value={preset}
                    onValueChange={(value) => setPreset(value as DesignFramePresetId)}
                  >
                    <SelectTrigger aria-label="Initial frame" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(DESIGN_FRAME_PRESETS) as DesignFramePresetId[]).map((id) => (
                        <SelectItem key={id} value={id}>
                          {DESIGN_FRAME_PRESETS[id].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              </div>
              {withAgent && (
                <div className="grid gap-1">
                  <div ref={briefRef} className="grid gap-1">
                    <label className="grid gap-1 text-sm">
                      Design brief
                      <Textarea
                        className="min-h-24"
                        maxLength={DESIGN_BRIEF_MAX}
                        placeholder="Review this repo and mock up…"
                        value={brief}
                        aria-describedby="design-brief-images-hint"
                        onChange={(event) => setBrief(event.target.value)}
                      />
                    </label>
                    <DesignPromptImages
                      images={briefImages}
                      disabled={busy}
                      onRemove={(id) =>
                        setBriefImages((current) => current.filter((image) => image.id !== id))
                      }
                    />
                    <p id="design-brief-images-hint" className="text-xs text-muted-foreground">
                      {imagePaste.isPasting ? "Attaching image…" : DESIGN_PROMPT_IMAGE_HINT}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1" aria-label="Brief examples">
                    {DESIGN_BRIEF_EXAMPLES.map((example) => (
                      <Button
                        key={example}
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-auto whitespace-normal py-1 text-left text-xs"
                        onClick={() => setBrief(example)}
                      >
                        {example}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">{DESIGN_CONTENT_EXPLANATION}</p>
              {(createBlocker || (plan.ok && plan.notice)) && (
                <p id="design-create-blocker" className="text-sm text-muted-foreground">
                  {createBlocker ?? (plan.ok ? plan.notice : null)}{" "}
                  {view && !readinessLoading && readinessBlocked && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 align-baseline"
                      onClick={refreshReadiness}
                    >
                      Check again
                    </Button>
                  )}
                </p>
              )}
              <Button
                type="submit"
                disabled={busy || imagePaste.isPasting || Boolean(createBlocker)}
                aria-describedby={createBlocker ? "design-create-blocker" : undefined}
              >
                {busy ? "Opening…" : withAgent ? "Create design workspace" : "Create blank canvas"}
              </Button>
            </form>
          </TabsContent>
          <TabsContent value="saved">
            {view && (
              <DesignLibrary
                environmentId={environmentId}
                backendKey={backendKey}
                legacy={legacy}
                canManage={Boolean(view.capabilities?.lifecycle)}
                openChoices={(canvasId) =>
                  environmentReady
                    ? designOpenChoices(canvasId, facts)
                    : {
                        canOpen: false,
                        besideFallsBack: false,
                        notice: "Start this environment to open designs.",
                      }
                }
                onOpen={openDesign}
              />
            )}
            {readinessLoading && <p className="text-sm">Loading designs…</p>}
          </TabsContent>
          <TabsContent value="open">
            <div className="grid gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy || !environmentId}
                onClick={() => void openFromPicker()}
              >
                {busy ? "Opening…" : "Choose .orkdes file…"}
              </Button>
              <p className="text-xs text-muted-foreground">
                Browse the files on the machine running Orkestrator. Version 1 .orkdes files up to 4
                MiB. Opening a file creates a new design with its own identity; conversation links
                and save locations from the original are not copied.
              </p>
              {uploadFallback && (
                <label className="grid gap-1 text-sm">
                  Upload .orkdes from this device
                  <Input
                    type="file"
                    accept=".orkdes,application/json"
                    aria-label="Import .orkdes"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void uploadFile(file);
                    }}
                  />
                </label>
              )}
              {rendererUnavailable(view) && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  The renderer is unavailable, so an opened design will be stored unvalidated until
                  it is available.
                </p>
              )}
            </div>
          </TabsContent>
        </Tabs>
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {error && (
          <div role="alert" className="grid gap-2 text-sm text-destructive">
            <p>{error}</p>
            {recovery && (
              <div className="flex flex-wrap items-center gap-2 text-foreground">
                <span>Your design “{recovery.name}” was created — open it to continue.</span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    const problem = openDesign(recovery.canvasId, "split");
                    if (problem) setError(problem);
                    else setRecovery(null);
                  }}
                >
                  Open design
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
