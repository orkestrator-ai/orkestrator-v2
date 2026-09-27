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
import { useConfigStore } from "@/stores";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { createUniqueTabId } from "@/components/terminal/TerminalContainer.helpers";
import { designAction, designApi, designBackendKey, failureOf } from "./design-client";
import {
  DESIGN_AGENTS,
  DESIGN_BRIEF_EXAMPLES,
  DESIGN_BRIEF_MAX,
  DESIGN_CONTENT_EXPLANATION,
  DESIGN_FRAME_PRESETS,
  DESIGN_NAME_MAX,
  DesignLaunchError,
  importAndOpenDesign,
  launchDesignWorkspace,
  loadDesignReadiness,
  readDesignImport,
  rendererUnavailable,
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
import { DESIGN_AGENT_LABELS, DesignReadinessPanel } from "./DesignReadinessPanel";
import { DesignLibrary, type DesignLibraryClient } from "./DesignLibrary";

export type DesignWorkspaceMode = "new" | "open" | "import";
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
  libraryClient,
  initialMode = "new",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  /** null while the environment is not running; the library stays browsable. */
  createTab: CreateTab | null;
  loadReadiness?: (probe: boolean) => Promise<DesignReadinessView>;
  libraryClient?: DesignLibraryClient;
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
  const [preset, setPreset] = useState<DesignFramePresetId>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ canvasId: string; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [libraryRefresh, setLibraryRefresh] = useState(0);

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
    setError(null);
    setRecovery(null);
    setNotice(null);
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
  const createBlocker = !environmentReady
    ? "Start this environment to create or open designs. You can still browse saved designs."
    : view && view.backend.state !== "connected"
      ? "Reconnect to the backend before creating a design."
      : view?.storage.state === "unavailable"
        ? "Design storage is unavailable."
        : rendererUnavailable(view)
          ? "Creating a design needs the renderer. You can still open, rename, export and import designs."
          : withAgent && !agents[agent]
            ? `${DESIGN_AGENT_LABELS[agent]} is disabled in Settings. Choose another agent or a blank canvas.`
            : !plan.ok
              ? plan.message
              : null;

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
      if (!createTab("design-canvas", { canvasId, designPlacement: decision.placement }))
        return "The design could not be opened in this layout. Close a tab or pane and try again.";
      onOpenChange(false);
      return null;
    },
    [createTab, environmentId, onOpenChange],
  );

  const create = async () => {
    setNameTouched(true);
    if (nameProblem || createBlocker || !createTab || !plan.ok) return;
    const launchScope = scopeRef.current;
    const originPaneId = usePaneLayoutStore
      .getState()
      .environments.get(environmentId)?.activePaneId;
    const sessions = view?.protocol === "v2" && view.capabilities?.sessions;
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
          designAction<DesignCanvas>(environmentId, "create_canvas", { name: canvasName }),
        createFrame: (canvas, frame) =>
          designAction<{ canvasRevision: number }>(environmentId, "create_frame", {
            canvasId: canvas.id,
            expectedRevision: canvas.revision,
            x: 0,
            y: 0,
            ...frame,
          }),
        openCanvas: (canvasId, tabId, placement) =>
          createTab("design-canvas", { canvasId, tabId, designPlacement: placement }),
        createAgentTab: (platform, tabId, initialPrompt) => {
          // The agent sits beside the canvas in the pane the user started from.
          if (originPaneId)
            usePaneLayoutStore.getState().setActivePane(originPaneId, environmentId);
          return createTab(platform, {
            tabId,
            agentLaunchMode: "native",
            displayTitle: "Design",
            initialPrompt,
          });
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
                designApi.linkSession(environmentId, canvasId, { tabId, platform, role: "design" }),
            }
          : {}),
      });
      if (launchScope !== scopeRef.current) return;
      if (result.linkWarning) toast.warning(result.linkWarning);
      setBrief("");
      setName("Untitled design");
      setNameTouched(false);
      onOpenChange(false);
    } catch (reason) {
      if (launchScope !== scopeRef.current) return;
      if (reason instanceof DesignLaunchError && reason.recoverable && reason.canvas)
        setRecovery({ canvasId: reason.canvas.id, name: reason.canvas.name });
      setError(errorText(reason));
    } finally {
      if (launchScope === scopeRef.current) setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    const importScope = scopeRef.current;
    const unvalidated = rendererUnavailable(view);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const document = await readDesignImport(file);
      const result = await importAndOpenDesign({
        document,
        importCanvas: (value) =>
          invoke<DesignCanvas>("design_import", { environmentId, document: value }),
        openCanvas: (canvasId) =>
          importScope === scopeRef.current ? openDesign(canvasId, "split") : "Environment changed.",
      });
      if (importScope !== scopeRef.current) return;
      const stored = `Imported “${result.canvas.name}”${
        unvalidated ? " — stored unvalidated until the renderer is available" : ""
      }.`;
      if (result.opened) toast.success(stored);
      else {
        setNotice(`${stored} It could not be opened yet: ${result.openError}`);
        setLibraryRefresh((value) => value + 1);
        setMode("open");
      }
    } catch (reason) {
      if (importScope === scopeRef.current) setError(errorText(reason));
    } finally {
      if (importScope === scopeRef.current) setBusy(false);
    }
  };

  const showNameError = nameTouched && nameProblem;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[min(42rem,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>Design workspace</DialogTitle>
          <DialogDescription>
            Design with Claude or Codex beside a shared HTML canvas, reopen a saved design, or
            import an .orkdes file.
          </DialogDescription>
        </DialogHeader>
        <DesignReadinessPanel
          view={view}
          loading={readinessLoading}
          onRetry={refreshReadiness}
          agents={agents}
          selectedAgent={withAgent ? agent : null}
        />
        <Tabs value={mode} onValueChange={(value) => setMode(value as DesignWorkspaceMode)}>
          <TabsList className="w-full">
            <TabsTrigger value="new">New design</TabsTrigger>
            <TabsTrigger value="open">Open</TabsTrigger>
            <TabsTrigger value="import">Import</TabsTrigger>
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
                  <label className="grid gap-1 text-sm">
                    Design brief
                    <Textarea
                      className="min-h-24"
                      maxLength={DESIGN_BRIEF_MAX}
                      placeholder="Review this repo and mock up…"
                      value={brief}
                      onChange={(event) => setBrief(event.target.value)}
                    />
                  </label>
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
                  {createBlocker ?? (plan.ok ? plan.notice : null)}
                </p>
              )}
              <Button
                type="submit"
                disabled={busy || Boolean(createBlocker)}
                aria-describedby={createBlocker ? "design-create-blocker" : undefined}
              >
                {busy ? "Opening…" : withAgent ? "Create design workspace" : "Create blank canvas"}
              </Button>
            </form>
          </TabsContent>
          <TabsContent value="open">
            {view && view.protocol !== "unknown" ? (
              <DesignLibrary
                key={legacy ? "legacy" : "v2"}
                environmentId={environmentId}
                backendKey={backendKey}
                legacy={legacy}
                canManage={Boolean(view.capabilities?.lifecycle)}
                client={libraryClient}
                openChoices={(canvasId) => designOpenChoices(canvasId, facts)}
                onOpen={openDesign}
                refreshToken={libraryRefresh}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {readinessLoading
                  ? "Loading designs…"
                  : "The design library is unavailable until the backend responds. Press Retry above."}
              </p>
            )}
          </TabsContent>
          <TabsContent value="import">
            <div className="grid gap-2">
              <label className="grid gap-1 text-sm">
                Import .orkdes
                <Input
                  type="file"
                  accept=".orkdes,application/json"
                  disabled={busy || !environmentId}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void importFile(file);
                  }}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Version 1 .orkdes files up to 4 MiB. An import gets a new identity; conversation
                links and save locations from the original are not copied.
              </p>
              {rendererUnavailable(view) && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  The renderer is unavailable, so an import will be stored unvalidated until it is
                  available.
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
