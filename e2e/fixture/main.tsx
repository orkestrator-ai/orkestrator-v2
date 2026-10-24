import { AgentAccountStatusFixture } from "./AgentAccountStatusFixture";
import { EnvironmentStatusMarkerFixture } from "./EnvironmentStatusMarkerFixture";
import { MergedProjectListFixture } from "../../apps/web/src/test/MergedProjectListFixture";
import { RemoteMachineTreeFixture } from "../../apps/web/src/test/RemoteMachineTreeFixture";
import { NativeAttachmentsFixture } from "./NativeAttachmentsFixture";
import { ChangeTrackingFixture, installChangeTrackingFixture } from "./changeTracking";
import { StructuredReviewLayoutFixture } from "./StructuredReviewLayoutFixture";
import { AnnotationDestinationLayoutFixture } from "./AnnotationDestinationLayoutFixture";
import { ClaudeInteractionsFixture } from "./ClaudeInteractionsFixture";
import {
  AgentLaunchDialog,
  type AgentLaunchSelection,
} from "../../apps/web/src/components/launch/AgentLaunchDialog";
import { OpenCodePipelineTranscriptFixture } from "./OpenCodePipelineTranscriptFixture";
import { TmuxComposeFocusFixture } from "./TmuxComposeFocusFixture";
import { AgentUsageFixture } from "./AgentUsageFixture";
import { AddProjectDialogFixture } from "./AddProjectDialogFixture";
import { BackgroundTaskOutcomeFixture } from "./BackgroundTaskOutcomeFixture";
import { CodexSubagentCardsFixture } from "./CodexSubagentCardsFixture";
import { MachinesSettingsFixture } from "./MachinesSettingsFixture";
import { DesignCanvasFixture } from "./DesignCanvasFixture";
import { MenuPlacementFixture } from "./MenuPlacementFixture";
import { ComposerIconPickersFixture } from "./ComposerIconPickersFixture";
import { ReadCoordinatorFixture } from "./ReadCoordinatorFixture";
import { CoordinatorPaneTreeFixture } from "./CoordinatorPaneTreeFixture";
import { StreamingTranscriptFixture } from "./StreamingTranscriptFixture";
import { FullscreenSettingsFixture } from "./FullscreenSettingsFixture";
import { SettingsMachineFixture } from "./SettingsMachineFixture";
import { GlobalSettingsFixture } from "./GlobalSettingsFixture";
import { GitHubCliSetupFixture } from "./GitHubCliSetupFixture";
import { MultiReviewFlowFixture } from "./MultiReviewFlowFixture";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { StrictMode, Suspense, lazy, createRef, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import "../../apps/web/src/index.css";
import { DesignLaunchButton } from "../../apps/web/src/components/design/DesignLaunchButton";
import {
  CreateEnvironmentDialog,
  type ClaudeOptions,
} from "../../apps/web/src/components/environments/CreateEnvironmentDialog";
import { BrowserTab } from "../../apps/web/src/components/browser/BrowserTab";
import { NativeComposeBar } from "../../apps/web/src/components/chat/NativeComposeBar";
import { QueuedPromptsDialog } from "../../apps/web/src/components/chat/QueuedPromptsDialog";
import { AgentThinkingIndicator } from "../../apps/web/src/components/chat/AgentThinkingIndicator";
import { NativeChatShell } from "../../apps/web/src/components/chat/NativeChatShell";
import { MessageShell } from "../../apps/web/src/components/chat/MessageShell";
import { MentionableInput } from "../../apps/web/src/components/chat/MentionableInput";
import { AgentModelPicker } from "../../apps/web/src/components/chat/AgentModelPicker";
import type { MentionableInputRef } from "../../apps/web/src/components/chat/MentionableInput";
import {
  COMPOSE_MAX_INPUT_HEIGHT,
  COMPOSE_MIN_INPUT_HEIGHT,
} from "../../apps/web/src/components/chat/compose-metrics";
import { DiffViewerTab } from "../../apps/web/src/components/terminal/DiffViewerTab";
import {
  addedFileDiffBody,
  diffFixtureObjectId,
  diffFixtureResourceKey,
  liveDiffFixtureBody,
  type DiffFixtureStatus,
} from "./diffViewerBackend";
import { TiptapMarkdownEditor } from "../../apps/web/src/components/markdown/TiptapMarkdownEditor";
import { MonacoFileEditor } from "../../apps/web/src/components/terminal/MonacoFileEditor";
import { ChangedFileItem } from "../../apps/web/src/components/files-panel/ChangedFileItem";
import { MobileAppShellLayout } from "../../apps/web/src/components/layout/MobileAppShellLayout";
import {
  PullRequestCheckStatus,
  PullRequestCheckStatusAnnouncement,
} from "../../apps/web/src/components/layout/PullRequestCheckStatus";
import { SystemUsageIndicator } from "../../apps/web/src/components/layout/SystemUsageIndicator";
import { TAB_STRIP_CLASS } from "../../apps/web/src/components/pane-layout/TabShell";
import { ProjectSearchBar } from "../../apps/web/src/components/sidebar/ProjectSearchBar";
import { SortableProjectFolder } from "../../apps/web/src/components/sidebar/SortableProjectFolder";
import { Button } from "../../apps/web/src/components/ui/button";
import { cn } from "../../apps/web/src/lib/utils";
import {
  projectFolderDragId,
  resolveSortProjectFolder,
} from "../../apps/web/src/lib/project-folders";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import { useProjectStore } from "../../apps/web/src/stores";
import { usePaneLayoutStore } from "../../apps/web/src/stores/paneLayoutStore";
import type { Project } from "../../apps/web/src/types";
import {
  ReviewLaunchDialog,
  type ReviewLaunchSelection,
  type ReviewModelCatalog,
} from "../../apps/web/src/components/review/ReviewLaunchDialog";
import {
  MultiReviewLaunchDialog,
  type MultiReviewLaunchSelection,
} from "../../apps/web/src/components/review/MultiReviewLaunchDialog";
import { MultiReviewTab } from "../../apps/web/src/components/review/MultiReviewTab";
import { MultiReviewDefaultsEditor } from "../../apps/web/src/components/settings/agent/MultiReviewDefaultsEditor";
import { ReviewValidationStatus } from "../../apps/web/src/components/review/ReviewValidationStatus";
import { BuildChatTab } from "../../apps/web/src/components/build-pipeline/BuildChatTab";
import {
  useBuildPipelineStore,
  type BuildPipeline,
} from "../../apps/web/src/stores/buildPipelineStore";
import { useMultiReviewStore } from "../../apps/web/src/stores/multiReviewStore";
import type { GitFileChange } from "../../apps/web/src/lib/backend";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { ReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import { useVirtuosoScrollState } from "../../apps/web/src/hooks/useVirtuosoScrollState";

const SidebarDragFixture = lazy(async () => ({
  default: (await import("../../apps/web/src/test/SidebarDragFixture")).SidebarDragFixture,
}));

const RichTranscriptPerfFixture = lazy(async () => ({
  default: (await import("./RichTranscriptPerfFixture")).RichTranscriptPerfFixture,
}));

const DesignLibraryPerfFixture = lazy(async () => ({
  default: (await import("./DesignLibraryPerfFixture")).DesignLibraryPerfFixture,
}));

const TranscriptPagingFixture = lazy(async () => ({
  default: (await import("./TranscriptPagingFixture")).TranscriptPagingFixture,
}));

const NativeHeldSendFixture = lazy(async () => ({
  default: (await import("./NativeHeldSendFixture")).NativeHeldSendFixture,
}));

const TerminalCornerToolbarFixture = lazy(async () => ({
  default: (await import("./TerminalCornerToolbarFixture")).TerminalCornerToolbarFixture,
}));

const TerminalLinksFixture = lazy(async () => ({
  default: (await import("./TerminalLinksFixture")).TerminalLinksFixture,
}));

const ProjectNavigationFixture = lazy(async () => ({
  default: (await import("./ProjectNavigationFixture")).ProjectNavigationFixture,
}));

const MailTilesFixture = lazy(async () => ({
  default: (await import("./MailTilesFixture")).MailTilesFixture,
}));

const CloseRetentionFixture = lazy(async () => ({
  default: (await import("./CloseRetentionFixture")).CloseRetentionFixture,
}));
const PaneBreakpointFixture = lazy(async () => ({
  default: (await import("./PaneBreakpointFixture")).PaneBreakpointFixture,
}));
const SetupRecoveryFixture = lazy(async () => ({
  default: (await import("./SetupRecoveryFixture")).SetupRecoveryFixture,
}));

const EnvironmentSettingsDrawerFixture = lazy(async () => ({
  default: (await import("./EnvironmentSettingsDrawerFixture")).EnvironmentSettingsDrawerFixture,
}));

declare global {
  interface Window {
    lastCreateEnvironmentOptions?: ClaudeOptions;
  }
}

function assertFixtureArgs(
  command: string,
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
) {
  const actualEntries = Object.entries(actual ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`Unexpected arguments for fixture command: ${command}`);
  }
}

function CreateEnvironmentFixture() {
  const [open, setOpen] = useState(true);

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <button type="button" onClick={() => setOpen(true)}>
        Reopen dialog
      </button>
      <CreateEnvironmentDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (options) => {
          window.lastCreateEnvironmentOptions = options;
        }}
        defaultPortMappings={[{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }]}
      />
    </main>
  );
}

function DesignLaunchFixture() {
  useEffect(() => {
    useEnvironmentStore.setState({
      environments: [
        {
          id: "design-fixture",
          environmentType: "local",
          status: "running",
          containerId: null,
          worktreePath: "/tmp/design-fixture",
        } as import("../../apps/web/src/types").Environment,
      ],
    });
    usePaneLayoutStore.setState((state) => ({
      hydration: new Map(state.hydration).set("design-fixture", "done"),
    }));
  }, []);

  // A healthy protocol-v2 backend with an empty design library.
  const capabilities = {
    protocolVersion: 2,
    responseVersion: 1,
    snapshot: true,
    operations: true,
    sync: true,
    save: true,
    history: true,
    lifecycle: true,
    rendererHealth: true,
    library: true,
    batch: true,
    sessions: true,
    validation: true,
    hierarchyPaging: true,
  };
  const ok = <T,>(value: unknown) => ({ ok: true, value }) as T;
  window.orkestrator = {
    invoke: async <T,>(command: string, args?: unknown) => {
      if (command === "write_local_file")
        return `/tmp/design-fixture/${(args as { filePath: string }).filePath}` as T;
      if (command === "design_status") return { ready: true } as T;
      if (command === "design_action") return [] as T;
      if (command === "design_capabilities") return ok<T>(capabilities);
      if (command === "design_readiness")
        return ok<T>({
          capabilities,
          storage: { available: true, canvases: 0, limit: 256 },
          renderer: {
            state: "ready",
            ready: true,
            message: "Design renderer is ready",
            queued: 0,
            running: 0,
            generation: 1,
            executableConfigured: false,
          },
        });
      if (command === "design_library")
        return ok<T>({
          entries: [],
          total: 0,
          quota: {
            live: 0,
            liveLimit: 256,
            deleted: 0,
            deletedLimit: 32,
            deletedBytes: 0,
            deletedBytesLimit: 128 * 1024 * 1024,
          },
        });
      throw new Error(`Unknown backend command: ${command}`);
    },
  } as Window["orkestrator"];

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <DesignLaunchButton
        environmentId="design-fixture"
        disabled={false}
        tabCount={0}
        createTab={() => true}
      />
    </main>
  );
}

function BrowserFixture() {
  const empty = new URLSearchParams(window.location.search).has("empty");

  return (
    <main className="min-h-screen bg-muted p-4 text-foreground">
      <section
        data-testid="browser-pane"
        className="relative h-[36rem] max-w-full border border-border"
        style={{ width: "400px" }}
      >
        <BrowserTab
          tabId="browser-fixture"
          environmentId="fixture-environment"
          data={{ url: empty ? "" : "http://localhost:3000/" }}
          isActive
        />
      </section>
    </main>
  );
}

const sortableFolderProjects: Project[] = [
  {
    id: "project-zulu",
    name: "Zulu",
    gitUrl: "https://example.invalid/zulu.git",
    localPath: null,
    addedAt: "2024-01-01T00:00:00.000Z",
    order: 0,
    folder: "Work",
  },
  {
    id: "project-alpha",
    name: "Alpha",
    gitUrl: "https://example.invalid/alpha.git",
    localPath: null,
    addedAt: "2024-01-01T00:00:00.000Z",
    order: 1,
    folder: "Work",
  },
];

function SortableProjectFolderFixture() {
  const [projects, setProjects] = useState(sortableFolderProjects);

  const sortProjects = () => {
    const arrangement = resolveSortProjectFolder(projects, "Work");
    if (!arrangement) return;
    const byId = new Map(projects.map((project) => [project.id, project]));
    setProjects(
      arrangement.projectIds.flatMap((projectId, order) => {
        const project = byId.get(projectId);
        return project ? [{ ...project, order }] : [];
      }),
    );
  };

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <DndContext>
        <SortableContext items={[projectFolderDragId("Work")]}>
          <SortableProjectFolder
            name="Work"
            projectCount={projects.length}
            isCollapsed={false}
            onToggleCollapse={() => {}}
            onRename={() => {}}
            onSort={sortProjects}
            onUngroup={() => {}}
          >
            <ol aria-label="Work projects">
              {projects.map((project) => (
                <li key={project.id} data-project-id={project.id}>
                  {project.name}
                </li>
              ))}
            </ol>
          </SortableProjectFolder>
        </SortableContext>
      </DndContext>
    </main>
  );
}

const queuedComposePrompts = Array.from({ length: 123 }, (_, index) => ({
  id: `queued-${index + 1}`,
  text: `Queued prompt ${index + 1}`,
}));

/**
 * The native composer as an agent tab assembles it: `NativeComposeBar` owns the
 * layout and the secondary controls, while the primary slot carries whatever
 * the agent contributes — here the unified `AgentModelPicker`.
 */
function NativeComposeFixture() {
  const [fastModeEnabled, setFastModeEnabled] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<MentionableInputRef | null>(null);
  const inputContainerRef = useRef<HTMLDivElement | null>(null);

  return (
    <main className="min-h-screen bg-background pt-4 text-foreground">
      <section data-testid="native-compose-fixture" className="w-full">
        <NativeComposeBar
          attachments={
            new URLSearchParams(window.location.search).has("images")
              ? ["first", "second"].map((name) => ({
                  id: name,
                  type: "image" as const,
                  name: `${name}.svg`,
                  path: `/${name}.svg`,
                  previewUrl: `data:image/svg+xml,${encodeURIComponent(
                    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${name === "first" ? "blue" : "red"}"/></svg>`,
                  )}`,
                }))
              : []
          }
          onRemoveAttachment={() => {}}
          inputRef={inputRef}
          inputContainerRef={inputContainerRef}
          text={text}
          mentions={[]}
          onTextAndMentionsChange={(nextText) => setText(nextText)}
          onCursorPositionChange={() => {}}
          onKeyDown={() => {}}
          placeholder="Send a message"
          queue={{ length: 123, onOpen: () => setQueueOpen(true) }}
          showAddressAll
          onAddressAll={async () => setSentCount((count) => count + 1)}
          onSend={async () => setSentCount((count) => count + 1)}
          onStop={async () => {}}
          primaryControls={
            <AgentModelPicker
              models={[
                {
                  platform: "codex",
                  id: "long-model",
                  label: "A deliberately long Codex model name for narrow viewport coverage",
                },
              ]}
              enabledPlatforms={["codex"]}
              selectedPlatform="codex"
              selectedModelId="long-model"
              selectedModelLabel="A deliberately long Codex model name for narrow viewport coverage"
              onModelChange={() => {}}
              reasoningOptions={[
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
              ]}
              selectedReasoningId="high"
              selectedReasoningLabel="High"
              onReasoningChange={() => {}}
              fastModeEnabled={fastModeEnabled}
              fastModeAvailable
              onFastModeChange={setFastModeEnabled}
            />
          }
        />
        <output data-testid="native-send-count">{sentCount}</output>
      </section>
      <QueuedPromptsDialog
        open={queueOpen}
        onOpenChange={setQueueOpen}
        messages={queuedComposePrompts}
        onEdit={() => {}}
        onMove={() => {}}
        onRemove={() => {}}
      />
    </main>
  );
}

const agentPickerModels = Array.from({ length: 8 }, (_, index) => ({
  platform: "codex" as const,
  id: `fixture-model-${index + 1}`,
  label: `Fixture model ${index + 1}`,
  description: `Description for fixture model ${index + 1}`,
}));

const agentPickerReasoningOptions = Array.from({ length: 12 }, (_, index) => ({
  id: `fixture-effort-${index + 1}`,
  label: `Fixture effort ${index + 1}`,
  description: `A detailed explanation for fixture reasoning effort ${index + 1}`,
}));

function AgentModelPickerFixture() {
  const [modelId, setModelId] = useState(agentPickerModels[0]!.id);
  const [reasoningId, setReasoningId] = useState(agentPickerReasoningOptions[0]!.id);
  const [fastMode, setFastMode] = useState(false);
  const model = agentPickerModels.find((entry) => entry.id === modelId)!;
  const reasoning = agentPickerReasoningOptions.find((entry) => entry.id === reasoningId)!;

  return (
    <main className="h-screen overflow-hidden bg-background p-4 text-foreground">
      <AgentModelPicker
        models={agentPickerModels}
        enabledPlatforms={["codex"]}
        selectedPlatform="codex"
        selectedModelId={modelId}
        selectedModelLabel={model.label}
        onModelChange={setModelId}
        reasoningOptions={agentPickerReasoningOptions}
        selectedReasoningId={reasoningId}
        selectedReasoningLabel={reasoning.label}
        onReasoningChange={setReasoningId}
        fastModeEnabled={fastMode}
        fastModeAvailable
        onFastModeChange={setFastMode}
      />
    </main>
  );
}

const reviewModelCatalog = {
  claude: [
    {
      id: "claude-sonnet",
      name: "Claude Sonnet",
      description: "Balanced reviews for everyday code changes",
      reasoningEfforts: ["low", "high"],
    },
  ],
  codex: [
    {
      id: "codex-review",
      name: "Codex Review",
      description: "Detailed code review with repository context",
      reasoningEfforts: ["medium", "high"],
    },
  ],
  opencode: [
    {
      id: "provider/opencode-review",
      name: "OpenCode Review",
      description: "Provider-managed review model",
      reasoningEfforts: ["fast", "deep"],
    },
  ],
} satisfies ReviewModelCatalog;

function AgentLaunchDialogFixture() {
  const [open, setOpen] = useState(true);
  const [selection, setSelection] = useState<AgentLaunchSelection | null>(null);
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <button type="button" onClick={() => setOpen(true)}>
        Reopen PR dialog
      </button>
      <output data-testid="pr-launch-selection">{selection?.targetBranch ?? ""}</output>
      <AgentLaunchDialog
        open={open}
        onOpenChange={setOpen}
        defaultAgent="claude"
        catalog={reviewModelCatalog}
        enabledAgents={["claude", "codex", "opencode"]}
        targetBranch="main"
        editableTargetBranch
        targetBranchSuggestions={["main", "release/2.0", "develop"]}
        onConfirm={(nextSelection) => {
          setSelection(nextSelection);
          setOpen(false);
        }}
      />
    </main>
  );
}

function ReviewLaunchDialogFixture() {
  const [open, setOpen] = useState(true);
  const [selection, setSelection] = useState<ReviewLaunchSelection | null>(null);

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <button type="button" onClick={() => setOpen(true)}>
        Reopen review dialog
      </button>
      <output data-testid="review-launch-selection">
        {selection
          ? `${selection.tabType}|${selection.model}|${selection.reasoningEffort ?? "default"}`
          : ""}
      </output>
      <ReviewLaunchDialog
        open={open}
        onOpenChange={setOpen}
        defaultTabType="claude"
        catalog={reviewModelCatalog}
        onConfirm={(nextSelection) => {
          setSelection(nextSelection);
          setOpen(false);
        }}
      />
    </main>
  );
}

function MultiReviewLaunchDialogFixture() {
  const [open, setOpen] = useState(true);

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <button type="button" onClick={() => setOpen(true)}>
        Reopen Multi Review dialog
      </button>
      <MultiReviewLaunchDialog
        open={open}
        onOpenChange={setOpen}
        defaultAgent="claude"
        catalog={reviewModelCatalog}
        onConfirm={() => setOpen(false)}
      />
    </main>
  );
}

function MultiReviewAutoFixFixture() {
  const [draft, setDraft] = useState<AgentSettingsTier>({});
  const [saved, setSaved] = useState<AgentSettingsTier>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selection, setSelection] = useState<MultiReviewLaunchSelection>();
  const [consolidated, setConsolidated] = useState(false);
  const [fixed, setFixed] = useState(false);
  const [prOpened, setPrOpened] = useState(false);

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <h1>Review settings</h1>
      <MultiReviewDefaultsEditor
        tier={draft}
        onChange={setDraft}
        tiers={{ global: draft }}
        canInherit={false}
        enabledPlatforms={["claude", "codex"]}
        catalog={reviewModelCatalog}
      />
      <button type="button" onClick={() => setSaved(draft)}>
        Save settings
      </button>
      <button type="button" onClick={() => setDialogOpen(true)}>
        Configure Multi Review
      </button>
      <MultiReviewLaunchDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        defaultAutoFix={saved.multiReview?.autoFix}
        defaultAutoPr={saved.multiReview?.autoPr}
        defaultAgent="claude"
        catalog={reviewModelCatalog}
        onConfirm={(nextSelection) => {
          setSelection(nextSelection);
          setDialogOpen(false);
        }}
      />
      {selection && (
        <button type="button" onClick={() => setConsolidated(true)}>
          Complete consolidation
        </button>
      )}
      {consolidated && selection?.autoFix && <div role="tab">Fix</div>}
      {consolidated && selection?.autoFix && (
        <button type="button" onClick={() => setFixed(true)}>
          Complete fix
        </button>
      )}
      {fixed && selection?.autoPr && (
        <button type="button" onClick={() => setPrOpened(true)}>
          Create PR
        </button>
      )}
      {prOpened && <div role="tab">PR</div>}
    </main>
  );
}

const multiReviewOverviewError = `Provider failure: ${"unbroken-session-token/".repeat(256)}`;
const multiReviewOverviewWorkflow: MultiReviewWorkflow = {
  version: 1,
  controller: "backend",
  id: "multi-review-overview-fixture",
  environmentId: "fixture-environment",
  projectId: "fixture-project",
  targetBranch: "main",
  phase: "failed",
  reviewers: [
    {
      id: "long-error-reviewer",
      agent: "claude",
      model: "opus",
      status: "failed",
      providerSessionId: "long-error-session",
      error: multiReviewOverviewError,
    },
    {
      id: "short-error-reviewer",
      agent: "codex",
      model: "gpt-5.6",
      status: "failed",
      providerSessionId: "short-error-session",
      error: "The reviewer session no longer exists",
    },
  ],
  fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
  error: "No reviewer produced a valid report",
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
  backendRevision: 1,
};

function MultiReviewOverviewFixture() {
  useEffect(() => {
    useMultiReviewStore.getState().replaceWorkflow(multiReviewOverviewWorkflow);
    return () => useMultiReviewStore.getState().removeWorkflow(multiReviewOverviewWorkflow.id);
  }, []);

  return (
    <main className="h-screen bg-background text-foreground">
      <MultiReviewTab
        data={{
          environmentId: multiReviewOverviewWorkflow.environmentId,
          workflowId: multiReviewOverviewWorkflow.id,
          isLocal: true,
        }}
        isActive
        hydrateWorkflow={async () => multiReviewOverviewWorkflow}
      />
    </main>
  );
}

const multiReviewRunningTileWorkflow: MultiReviewWorkflow = {
  version: 1,
  controller: "backend",
  id: "multi-review-running-tile-fixture",
  environmentId: "fixture-environment",
  projectId: "fixture-project",
  targetBranch: "main",
  phase: "reviewing",
  reviewers: [
    {
      id: "tool-mode-preparing-reviewer",
      agent: "claude",
      model: "opus",
      status: "running",
      providerSessionId: "tool-mode-preparing-session",
      resultTransport: "tool-v1",
      resultSubmission: "preparing",
      startedAt: "2026-09-07T00:00:00.000Z",
    },
    {
      id: "tool-mode-correcting-reviewer",
      agent: "codex",
      model: "gpt-5.6",
      status: "running",
      providerSessionId: "tool-mode-correcting-session",
      resultTransport: "tool-v1",
      resultSubmission: "correcting",
      startedAt: "2026-09-07T00:00:00.000Z",
    },
  ],
  fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
  backendRevision: 1,
};

function MultiReviewRunningTileFixture() {
  useEffect(() => {
    useMultiReviewStore.getState().replaceWorkflow(multiReviewRunningTileWorkflow);
    return () => useMultiReviewStore.getState().removeWorkflow(multiReviewRunningTileWorkflow.id);
  }, []);

  return (
    <main className="h-screen bg-background text-foreground">
      <MultiReviewTab
        data={{
          environmentId: multiReviewRunningTileWorkflow.environmentId,
          workflowId: multiReviewRunningTileWorkflow.id,
          isLocal: true,
        }}
        isActive
        hydrateWorkflow={async () => multiReviewRunningTileWorkflow}
      />
    </main>
  );
}

function GlobalStylesFixture() {
  const twelveLineDraft = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join("\n");
  const thirteenLineDraft = `${twelveLineDraft}\nLine 13`;

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <AgentThinkingIndicator agentName="Codex" />
      <section data-testid="agent-connecting-shell" className="h-64">
        <NativeChatShell
          agentLabel="Codex"
          platform="codex"
          agentExpansionScope="fixture-connecting"
          isActive
          connectionState="connecting"
          onRetry={() => {}}
          messages={[]}
          isLoading={false}
          elapsedSeconds={null}
          finalElapsedSeconds={null}
          centerCompose={false}
          composer={<textarea aria-label="Prompt" />}
          isAtBottom
          scrollToBottom={() => {}}
          scrollProps={{
            followOutput: () => false,
            atBottomStateChange: () => {},
            atBottomThreshold: 100,
            restoreStateFrom: undefined,
          }}
          virtuosoRef={createRef<VirtuosoHandle>()}
        />
      </section>
      <div data-testid="chat-status-row" className="chat-status-row">
        <span data-testid="chat-status-content">Completed</span>
      </div>
      <section data-testid="assistant-message-shell">
        <MessageShell
          isUser={false}
          authorLabel="Assistant"
          timestampLabel="1:00 PM"
          actions={
            <button data-testid="assistant-message-action" type="button">
              Copy
            </button>
          }
        >
          <p>Assistant message</p>
        </MessageShell>
      </section>
      <section data-testid="user-message-shell">
        <MessageShell
          isUser={true}
          authorLabel="You"
          timestampLabel="1:01 PM"
          onUserLongPress={() => undefined}
          actions={
            <button data-testid="user-message-action" type="button">
              Fork
            </button>
          }
        >
          <p>User message</p>
        </MessageShell>
      </section>
      <div data-testid="sidebar-glass" className="sidebar-glass">
        Sidebar
      </div>
      <div data-testid="panel-surface" className="panel-surface">
        Panel
      </div>
      <div data-testid="drag-region" data-backend-drag-region>
        Drag region
      </div>
      <div data-testid="no-select" className="no-select">
        No selection
      </div>
      <div data-testid="terminal-container" className="terminal-container">
        <div data-testid="xterm" className="xterm" style={{ height: "120px", width: "220px" }}>
          <div
            data-testid="xterm-viewport"
            className="xterm-viewport"
            style={{ overflowY: "scroll" }}
          >
            <div style={{ height: "240px" }} />
          </div>
          <div data-testid="xterm-screen" className="xterm-screen">
            <canvas data-testid="xterm-canvas" />
          </div>
          <div data-testid="xterm-scrollable" className="xterm-scrollable-element" />
        </div>
      </div>
      <div data-testid="scroll-host" className="h-20 w-20 overflow-scroll">
        <div className="h-40 w-40" />
      </div>
      <div data-mobile-toolbar>
        <button data-testid="mobile-toolbar-button" type="button">
          Tool
        </button>
      </div>
      <div className="mobile-sidebar">
        <div data-testid="mobile-sidebar-header" data-sidebar-header>
          Mobile sidebar
        </div>
      </div>
      <input data-testid="mobile-input" aria-label="Mobile input" />
      <textarea data-testid="mobile-textarea" aria-label="Mobile textarea" />
      <select data-testid="mobile-select" aria-label="Mobile select">
        <option>Value</option>
      </select>
      <div className="w-80">
        <div data-testid="native-compose-twelve-lines">
          <MentionableInput
            value={twelveLineDraft}
            mentions={[]}
            onChange={() => {}}
            minHeight={COMPOSE_MIN_INPUT_HEIGHT}
            maxHeight={COMPOSE_MAX_INPUT_HEIGHT}
          />
        </div>
        <div data-testid="native-compose-thirteen-lines">
          <MentionableInput
            value={thirteenLineDraft}
            mentions={[]}
            onChange={() => {}}
            minHeight={COMPOSE_MIN_INPUT_HEIGHT}
            maxHeight={COMPOSE_MAX_INPUT_HEIGHT}
          />
        </div>
      </div>
      <div data-testid="dropdown-content" data-slot="dropdown-menu-content">
        Dropdown
      </div>
      <div data-testid="context-content" data-slot="context-menu-content">
        Context
      </div>
      <div data-testid="dropdown-item" data-slot="dropdown-menu-item">
        Dropdown item
      </div>
      <div data-testid="context-item" data-slot="context-menu-item">
        Context item
      </div>
    </main>
  );
}

function MarkdownEditorFixture() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <TiptapMarkdownEditor
        markdown={"Inline `chip` text.\n\n```bash\nmise install\nmise run dev\n```"}
        fontFamily="Fira Code"
        fontSize={14}
        onChange={() => {}}
        onSave={() => {}}
      />
    </main>
  );
}

function MonacoRuntimeFixture() {
  const [value, setValue] = useState("const answer: number = 42;\n");

  return (
    <main className="h-screen bg-background p-4 text-foreground">
      <section data-testid="monaco-runtime-editor" className="h-[32rem] border border-border">
        <MonacoFileEditor
          language="typescript"
          value={value}
          onChange={setValue}
          onSave={() => undefined}
          isActive
        />
      </section>
      <output data-testid="monaco-runtime-value" className="sr-only">
        {value}
      </output>
    </main>
  );
}

const mobileShellTitle =
  "A project and environment name that is far too long for a mobile title bar";

function MobileAppShellFixture() {
  const [dragStarts, setDragStarts] = useState(0);
  const searchParams = new URLSearchParams(window.location.search);
  const desktop = searchParams.has("desktop");
  const withoutInbox = searchParams.has("withoutInbox");

  if (desktop) {
    delete window.orkestrator;
    window.orkestratorGateway = { enabled: true, desktop: true };
  } else {
    delete window.orkestrator;
    window.orkestratorGateway = { enabled: true };
  }

  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <MobileAppShellLayout
        selectedProjectId="project-1"
        selectedEnvironmentId="environment-1"
        title={mobileShellTitle}
        filesPanelOpen={false}
        centralPanelStyle={{ backgroundColor: "rgb(1, 2, 3)" }}
        actionBar={<button type="button">Action</button>}
        agentInfoButton={
          <>
            {!withoutInbox && <button type="button" className="h-7 w-7" aria-label="Agent inbox" />}
            <button type="button" className="h-9 w-9" aria-label="Agent info" />
          </>
        }
        sidebar={<div>Projects</div>}
        filesPanel={<div>Files</div>}
        onTitleBarMouseDown={() => setDragStarts((count) => count + 1)}
      >
        <div>Workspace</div>
      </MobileAppShellLayout>
      <output data-testid="mobile-shell-drag-starts" className="sr-only">
        {dragStarts}
      </output>
    </main>
  );
}

const pathFixtures = {
  posix: "packages/a-very-long-directory-name/src/components/ImportantButton.tsx",
  windows: String.raw`packages\a-very-long-directory-name\src\components\ImportantPanel.tsx`,
  // Both leading characters are bidi-neutral, so the RTL truncation direction
  // reorders them to the visual end of the segment unless the directory text is
  // kept in its own LTR isolate. The parens are additionally mirrored glyphs.
  dotted: ".playwright-mcp/(a-very-long-group)/src/ImportantTrace.yml",
} as const;

const changedFileFixtures = {
  "changed-file-path-pane": {
    path: pathFixtures.posix,
    directory: "packages/a-very-long-directory-name/src/components",
    filename: "ImportantButton.tsx",
    additions: 0,
    deletions: 0,
    status: "M",
  },
  "changed-file-dotted-path-pane": {
    path: pathFixtures.dotted,
    directory: ".playwright-mcp/(a-very-long-group)/src",
    filename: "ImportantTrace.yml",
    additions: 0,
    deletions: 0,
    status: "M",
  },
} satisfies Record<string, GitFileChange>;

function pathPaneIdentityId(kind: string) {
  return `path-truncation-${kind}`;
}

function PathTruncationFixture() {
  const bodies = new Map(
    Object.entries(pathFixtures).map(([kind, filePath]) => {
      const id = pathPaneIdentityId(kind);
      return [id, addedFileDiffBody(id, filePath)] as const;
    }),
  );
  window.orkestrator = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      const body = bodies.get(String(args?.diffIdentityId));
      if (command !== "changes_get_diff" || !body) {
        throw new Error(`Unexpected fixture command: ${command}`);
      }
      return body as T;
    },
    listen: () => () => undefined,
  } as unknown as Window["orkestrator"];

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      {Object.entries(changedFileFixtures).map(([pane, change]) => (
        <section
          key={pane}
          data-testid={pane}
          className="mb-4 border border-border"
          style={{ width: "640px" }}
        >
          <ChangedFileItem change={change} />
        </section>
      ))}
      {Object.entries(pathFixtures).map(([kind, filePath]) => (
        <section
          key={kind}
          data-testid={`${kind}-path-pane`}
          className="relative mb-4 h-48 overflow-hidden border border-border"
          style={{ width: "640px" }}
        >
          <DiffViewerTab
            target={{
              kind: "historical",
              diffIdentityId: pathPaneIdentityId(kind),
              title: filePath,
            }}
            filePath={filePath}
            isActive
          />
        </section>
      ))}
    </main>
  );
}

const buildPipelineHeaderFixture: BuildPipeline = {
  id: "header-pipeline",
  taskId: "header-task",
  projectId: "header-project",
  environmentId: "header-environment",
  environmentType: "local",
  agentType: "codex",
  phase: "building",
  sessions: [
    {
      phase: "build",
      iteration: 0,
      sessionKey: "header-build-key",
      sdkSessionId: "header-build-session",
      status: "running",
      startedAt: "2026-08-29T00:00:00.000Z",
      label: "Build Session",
      messages: [],
    },
  ],
  currentSessionIndex: 0,
  iteration: 0,
  maxIterations: 3,
  createdAt: "2026-08-29T00:00:00.000Z",
  taskTitle: "A deliberately long build pipeline title that must yield space to every control",
  taskSnapshot: {
    title: "A deliberately long build pipeline title that must yield space to every control",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    images: [],
  },
  backendRevision: 1,
  controller: "backend",
};

/** A real-layout fixture for the header's narrowest three-control state. */
function BuildPipelineHeaderFixture() {
  useEffect(() => {
    useBuildPipelineStore.setState({
      pipelines: new Map([[buildPipelineHeaderFixture.id, buildPipelineHeaderFixture]]),
      buildEnvironmentIds: new Set([buildPipelineHeaderFixture.environmentId]),
    });
    return () => {
      useBuildPipelineStore.setState({
        pipelines: new Map(),
        buildEnvironmentIds: new Set(),
      });
    };
  }, []);

  return (
    <main className="h-screen w-full bg-background text-foreground">
      <BuildChatTab
        data={{
          pipelineId: buildPipelineHeaderFixture.id,
          environmentId: buildPipelineHeaderFixture.environmentId,
          taskId: buildPipelineHeaderFixture.taskId,
          isLocal: true,
        }}
        isActive
      />
    </main>
  );
}

/**
 * Renders the diff viewer at full height so the phone layout (unified rows,
 * wrapped lines, compact header) can be inspected at a real mobile viewport.
 * `?status=` picks the modified/new/deleted body; `?branch=` names the baseline
 * ref the backend reports as `ref@oid`.
 */
function DiffViewerFixture() {
  const params = new URLSearchParams(window.location.search);
  const statusParam = params.get("status");
  const status: DiffFixtureStatus =
    statusParam === "new" ? "new" : statusParam === "deleted" ? "deleted" : "modified";
  const filePath = "docs/audits/frontend-state-audit.md";
  const baselineVersion = `${params.get("branch") ?? "main"}@${diffFixtureObjectId}`;
  const [viewFileCount, setViewFileCount] = useState(0);
  const body = liveDiffFixtureBody({ path: filePath, status, baselineVersion });

  window.orkestrator = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case "changes_resolve_live_detail":
          assertFixtureArgs(command, args, { resourceKey: diffFixtureResourceKey, path: filePath });
          return { kind: "identity", identity: body.identity } as T;
        case "changes_get_diff":
          assertFixtureArgs(command, args, { diffIdentityId: body.identity.id });
          return body as T;
        case "changes_get_view":
          // The shared projection subscription; the viewer does not depend on it.
          return {
            kind: "error",
            error: { code: "unsupported-capability", reasonKey: "changes.error.unsupported" },
          } as T;
        default:
          throw new Error(`Unexpected fixture command: ${command}`);
      }
    },
    listen: () => () => undefined,
  } as unknown as Window["orkestrator"];

  return (
    <main className="h-screen bg-background text-foreground">
      <section data-testid="diff-viewer-pane" className="relative h-full w-full">
        <DiffViewerTab
          target={{
            kind: "live",
            resourceKey: diffFixtureResourceKey,
            path: filePath,
            title: "frontend-state-audit.md",
          }}
          filePath={filePath}
          isActive
          onSwitchToFileView={() => setViewFileCount((count) => count + 1)}
        />
      </section>
      <output data-testid="view-file-count" className="sr-only">
        {viewFileCount}
      </output>
    </main>
  );
}

function validationCommand(id: string, command: string) {
  return {
    id,
    command,
    cwd: ".",
    dependsOn: [] as string[],
    resources: [id],
    weight: 1 as const,
    timeoutMs: 1_200_000,
  };
}

function validationResult(
  id: string,
  command: string,
  durationMs: number,
  queuedMs?: number,
  overrides: Partial<ReviewValidationRun["results"][number]> = {},
): ReviewValidationRun["results"][number] {
  return {
    id,
    command,
    status: "passed",
    exitCode: 0,
    stdoutPath: `.orkestrator/${id}.stdout`,
    stderrPath: `.orkestrator/${id}.stderr`,
    stdoutBytes: 12,
    stderrBytes: 0,
    startedAt: "2026-09-08T20:00:02.000Z",
    durationMs,
    queuedMs,
    limitation: null,
    ...overrides,
  };
}

const longValidationCommand =
  "mise run test:logged -- --name review-validation-output -- bun test ./apps/web/src/components/review/ReviewValidationStatus.test.tsx --parallel=1 --only-failures";

const reviewValidationOutputRun: ReviewValidationRun = {
  id: "validation-1",
  status: "completed",
  startedAt: "2026-09-08T20:00:00.000Z",
  completedAt: "2026-09-08T20:00:12.000Z",
  discoveryDurationMs: 1_000,
  sealingDurationMs: 200,
  plan: {
    headRef: "a".repeat(40),
    commands: [
      validationCommand("test", "mise run test"),
      validationCommand("cargo", longValidationCommand),
      validationCommand("typecheck", "mise run typecheck"),
      validationCommand("lint", "mise run lintfix"),
      validationCommand("format", "mise run formatcheck"),
      validationCommand("build", "mise run buildworld"),
    ],
    limitations: [],
  },
  results: [
    validationResult("test", "mise run test", 2_300),
    validationResult("cargo", longValidationCommand, 8_000, 2_000),
    validationResult("typecheck", "mise run typecheck", 4_100, 4_000, {
      status: "queued",
      queueReason:
        "Waiting for exclusive resource held by worktree abcdef012345 (PID 1234); 2/8 slots and 2048/85196 MiB reserved; needs 3 slots and 3072 MiB.",
      exitCode: null,
    }),
    validationResult("lint", "mise run lintfix", 1_000),
    validationResult("format", "mise run formatcheck", 900),
    validationResult("build", "mise run buildworld", 46_200, 1_200, {
      limitation: "Build runner was unavailable.",
    }),
  ],
};

function ReviewValidationOutputFixture() {
  const [visible, setVisible] = useState(true);
  const [run, setRun] = useState(reviewValidationOutputRun);
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <button type="button" onClick={() => setVisible((value) => !value)}>
        {visible ? "Hide validation" : "Show validation"}
      </button>
      <button
        type="button"
        onClick={() =>
          setRun({
            ...reviewValidationOutputRun,
            id: "validation-stop-demo",
            status: "running",
            completedAt: undefined,
            results: reviewValidationOutputRun.results.map((result) =>
              result.id === "typecheck" ? { ...result, status: "queued" } : { ...result },
            ),
          })
        }
      >
        Show running validation
      </button>
      <button
        type="button"
        onClick={() =>
          setRun((value) => ({
            ...value,
            results: value.results.map((result) =>
              result.id === "typecheck"
                ? { ...result, status: "incomplete", limitation: "Stopped by the user" }
                : result,
            ),
          }))
        }
      >
        Settle stopped command
      </button>
      <button
        type="button"
        onClick={() =>
          setRun((value) => ({
            ...value,
            results: value.results.map((result) =>
              result.status === "queued"
                ? { ...result, status: "passed", exitCode: 0, queueReason: undefined }
                : result,
            ),
          }))
        }
      >
        Complete background validation
      </button>
      {visible && (
        <ReviewValidationStatus
          environmentId="env-1"
          run={run}
          stopCommand={async () => run}
          loadOutput={async () => ({
            resultId: "test",
            status: "passed",
            stdout: {
              contentBase64: btoa("ok\n"),
              totalBytes: 3,
              startOffset: 0,
            },
            stderr: null,
          })}
        />
      )}
    </main>
  );
}

function NativeRefreshShimmerFixture() {
  const [generation, setGeneration] = useState(0);
  const [settled, setSettled] = useState(false);

  return (
    <main className="h-screen bg-background text-foreground">
      <button
        type="button"
        onClick={() => {
          setSettled(false);
          setGeneration((value) => value + 1);
        }}
      >
        Remount session
      </button>
      <button type="button" onClick={() => setSettled(true)}>
        Settle session
      </button>
      <section data-testid="native-refresh-shimmer-shell" className="h-[32rem]">
        <NativeChatShell
          key={generation}
          agentLabel="Codex"
          platform="codex"
          agentExpansionScope="fixture-refresh-shimmer"
          isActive
          connectionState={settled ? "connected" : "connecting"}
          displayAvailable
          sessionEstablished
          transcriptRefreshing={!settled}
          transcriptSettled={settled}
          onRetry={() => {}}
          messages={[
            {
              id: "assistant-1",
              role: "assistant",
              content: "Cached answer",
              createdAt: "2026-09-09T00:00:00.000Z",
              parts: [{ type: "text", content: "Cached answer" }],
            },
          ]}
          isLoading={false}
          elapsedSeconds={null}
          finalElapsedSeconds={null}
          centerCompose={false}
          composer={<textarea aria-label="Prompt" />}
          isAtBottom
          scrollToBottom={() => {}}
          scrollProps={{
            followOutput: () => false,
            atBottomStateChange: () => {},
            atBottomThreshold: 100,
            restoreStateFrom: undefined,
          }}
          virtuosoRef={createRef<VirtuosoHandle>()}
        />
      </section>
    </main>
  );
}

function NativeHydratingPreviewFixture() {
  const [hydrated, setHydrated] = useState(false);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const messages = Array.from({ length: 80 }, (_, index) => ({
    id: `message-${index}`,
    role: "assistant" as const,
    content:
      hydrated && index === 0
        ? "Hydrated transcript snapshot"
        : `Preview transcript row ${index + 1}`,
    createdAt: "2026-09-09T00:00:00.000Z",
    parts: [
      {
        type: "text" as const,
        content:
          hydrated && index === 0
            ? "Hydrated transcript snapshot"
            : `Preview transcript row ${index + 1}`,
      },
    ],
  }));
  const messageWindow = hydrated
    ? undefined
    : {
        limit: messages.length,
        truncated: true,
        truncationReason: "count" as const,
        canLoadEarlier: false,
      };
  const showLoadEarlier = messageWindow?.canLoadEarlier === true;

  return (
    <main className="h-screen bg-background p-4 text-foreground">
      <button type="button" onClick={() => setHydrated(true)}>
        Hydrate transcript
      </button>
      <output data-testid="native-hydration-state">{hydrated ? "hydrated" : "preview"}</output>
      <section data-testid="native-hydrating-preview-shell" className="h-[32rem]">
        <NativeChatShell
          agentLabel="Codex"
          platform="codex"
          agentExpansionScope="fixture-hydrating-preview"
          isActive
          connectionState="connected"
          displayAvailable
          sessionEstablished
          transcriptSettled
          onRetry={() => {}}
          messages={messages}
          transcriptHeader={
            showLoadEarlier ? <button type="button">Load earlier messages</button> : null
          }
          isLoading={false}
          elapsedSeconds={null}
          finalElapsedSeconds={null}
          centerCompose={false}
          composer={<textarea aria-label="Prompt" />}
          isAtBottom={false}
          scrollToBottom={() => {}}
          scrollProps={{
            followOutput: () => false,
            atBottomStateChange: () => {},
            atBottomThreshold: 100,
            restoreStateFrom: undefined,
          }}
          virtuosoRef={virtuosoRef}
        />
      </section>
    </main>
  );
}

function systemUsageFixtureSnapshot() {
  return {
    cpuPercent: 12.4,
    ramPercent: 47.6,
    gpuPercent: null,
    diskPercent: 63.2,
    sampledAt: new Date().toISOString(),
  };
}

function systemUsageProcessSnapshot() {
  return {
    sampledAt: new Date().toISOString(),
    truncated: false,
    environments: [
      {
        environmentId: "env-local",
        environmentName: "title-bar-layout",
        projectId: "project-1",
        environmentType: "local" as const,
        processes: [
          {
            pid: 11,
            name: "node",
            command: "/usr/local/bin/node server.js",
            cpuPercent: 18.2,
            ramPercent: 4.4,
            rssKb: 120_000,
          },
        ],
        totalCpuPercent: 18.2,
        totalRssKb: 120_000,
        processCount: 1,
      },
    ],
  };
}

/**
 * Title-bar meters plus the default Create PR button, so the process panel's
 * environment names and totals can be compared to the compiled primary fill.
 */
function SystemUsageFixture() {
  useEffect(() => {
    useProjectStore.getState().setProjects([
      {
        id: "project-1",
        name: "orkestrator-v2",
        gitUrl: "git@example.com:org/repo.git",
        localPath: null,
        addedAt: "2026-09-13T00:00:00.000Z",
        order: 0,
      },
    ]);
    return () => useProjectStore.getState().setProjects([]);
  }, []);

  window.orkestrator = {
    invoke: async <T,>(command: string) => {
      switch (command) {
        case "get_system_usage":
          return systemUsageFixtureSnapshot() as T;
        case "get_environment_process_usage":
          return systemUsageProcessSnapshot() as T;
        default:
          throw new Error(`Unexpected fixture command: ${command}`);
      }
    },
  } as Window["orkestrator"];

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header
        data-testid="system-usage-title-bar"
        className="flex items-center justify-end gap-3 border-b border-border px-3 py-2"
      >
        <SystemUsageIndicator />
        <Button size="sm" className="gap-2" aria-label="Create PR">
          PR
        </Button>
      </header>
    </main>
  );
}

function WorkspaceBarHeightFixture() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border/80">
        <div
          data-testid="workspace-sidebar-header"
          className="flex h-12 shrink-0 items-center border-b border-border/80 bg-chrome px-3"
        >
          Sidebar
        </div>
        <ProjectSearchBar
          projects={[]}
          environments={[]}
          onSelectProject={() => undefined}
          onSelectEnvironment={() => undefined}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          data-testid="workspace-action-bar"
          className="flex h-14 shrink-0 items-center border-b border-border/80 px-3 md:h-12"
        >
          Actions
        </div>
        <div data-testid="workspace-tab-strip" className={TAB_STRIP_CLASS}>
          <span className="px-2 text-sm">Terminal</span>
        </div>
      </div>
    </div>
  );
}

const initialVirtuosoMessages = Array.from({ length: 80 }, (_, index) => index + 1);

function VirtuosoFollowFixture() {
  const [messages, setMessages] = useState(initialVirtuosoMessages);
  const [lastFollowDecision, setLastFollowDecision] = useState<string>("unset");
  const { isAtBottom, scrollProps, virtuosoRef } = useVirtuosoScrollState();

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <div className="mb-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setLastFollowDecision(String(scrollProps.followOutput(false)));
            setMessages((current) => [...current, current.length + 1]);
          }}
        >
          Append message
        </button>
        <output data-testid="virtuoso-follow-count">{messages.length}</output>
        <output data-testid="virtuoso-at-bottom">{String(isAtBottom)}</output>
        <output data-testid="virtuoso-follow-decision">{lastFollowDecision}</output>
      </div>
      <Virtuoso
        // Only Virtuoso's own props; following may run only while allowed
        // (literal false otherwise), as the shared transcript list wires it.
        followOutput={scrollProps.followEnabled ? scrollProps.followOutput : false}
        atBottomStateChange={scrollProps.atBottomStateChange}
        atBottomThreshold={scrollProps.atBottomThreshold}
        totalListHeightChanged={scrollProps.totalListHeightChanged}
        restoreStateFrom={scrollProps.restoreStateFrom}
        scrollerRef={scrollProps.scrollerRef}
        ref={virtuosoRef}
        data={messages}
        fixedItemHeight={40}
        initialTopMostItemIndex={initialVirtuosoMessages.length - 1}
        itemContent={(_index, message) => (
          <div className="h-10 border-b border-border px-3 py-2">Message {message}</div>
        )}
        style={{ height: 320, width: 480 }}
      />
    </main>
  );
}

function PullRequestCheckStatusFixture() {
  const [summary, setSummary] = useState({ passed: 3, total: 4, pending: 1 });
  const searchParams = new URLSearchParams(window.location.search);
  const isGrid = searchParams.has("grid");
  const isDark = searchParams.has("dark");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    return () => document.documentElement.classList.add("dark");
  }, [isDark]);

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <div className={cn(isGrid ? "grid w-40 grid-cols-1" : "flex items-center")}>
        <Button size="sm" variant={isGrid ? "ghost" : "outline"} className="min-w-0 gap-2">
          <span className={cn(isGrid && "truncate text-xs")}>View PR</span>
          <PullRequestCheckStatus checkSummary={summary} className={cn(isGrid && "text-xs")} />
        </Button>
        <PullRequestCheckStatusAnnouncement checkSummary={summary} />
      </div>
      <div className="mt-4 flex gap-2">
        <button type="button" onClick={() => setSummary({ passed: 1, total: 4, pending: 2 })}>
          Continue with failure
        </button>
        <button type="button" onClick={() => setSummary({ passed: 3, total: 4, pending: 0 })}>
          Complete with failure
        </button>
        <button type="button" onClick={() => setSummary({ passed: 4, total: 4, pending: 0 })}>
          Complete successfully
        </button>
      </div>
    </main>
  );
}

function fixtureForPath() {
  if (window.location.pathname === "/annotation-destination-layout")
    return <AnnotationDestinationLayoutFixture />;
  if (window.location.pathname === "/structured-review-layout")
    return <StructuredReviewLayoutFixture />;
  if (window.location.pathname === "/setup-recovery") {
    return (
      <Suspense fallback={null}>
        <SetupRecoveryFixture />
      </Suspense>
    );
  }
  if (window.location.pathname === "/coordinator-pane-tree") return <CoordinatorPaneTreeFixture />;
  if (window.location.pathname === "/add-project") return <AddProjectDialogFixture />;
  if (window.location.pathname === "/mail-tiles") {
    return (
      <Suspense fallback={null}>
        <MailTilesFixture />
      </Suspense>
    );
  }
  if (window.location.pathname === "/project-navigation") {
    return (
      <Suspense fallback={null}>
        <ProjectNavigationFixture />
      </Suspense>
    );
  }
  if (window.location.pathname === "/terminal-corner-toolbar") {
    return (
      <Suspense fallback={null}>
        <TerminalCornerToolbarFixture />
      </Suspense>
    );
  }

  if (window.location.pathname === "/close-retention") {
    return (
      <Suspense fallback={null}>
        <CloseRetentionFixture />
      </Suspense>
    );
  }
  if (window.location.pathname === "/pane-breakpoint") {
    return (
      <Suspense fallback={null}>
        <PaneBreakpointFixture />
      </Suspense>
    );
  }
  if (window.location.pathname === "/terminal-links") {
    return (
      <Suspense fallback={null}>
        <TerminalLinksFixture />
      </Suspense>
    );
  }
  if (window.location.pathname === "/sidebar-drag") {
    return (
      <Suspense fallback={null}>
        <SidebarDragFixture />
      </Suspense>
    );
  }
  if (window.location.pathname === "/merged-project-list") return <MergedProjectListFixture />;
  if (window.location.pathname === "/environment-status-marker")
    return <EnvironmentStatusMarkerFixture />;
  if (window.location.pathname === "/remote-machine-tree") return <RemoteMachineTreeFixture />;
  if (window.location.pathname === "/agent-account-status") return <AgentAccountStatusFixture />;
  if (window.location.pathname === "/machines-settings") return <MachinesSettingsFixture />;
  if (window.location.pathname === "/fullscreen-settings") return <FullscreenSettingsFixture />;
  if (window.location.pathname === "/settings-machines") return <SettingsMachineFixture />;
  if (window.location.pathname === "/global-settings") return <GlobalSettingsFixture />;
  if (window.location.pathname === "/github-cli-setup") return <GitHubCliSetupFixture />;
  if (window.location.pathname === "/design-canvas") return <DesignCanvasFixture />;
  if (window.location.pathname === "/design-launch") return <DesignLaunchFixture />;
  if (window.location.pathname === "/browser") return <BrowserFixture />;
  if (window.location.pathname === "/sortable-project-folder") {
    return <SortableProjectFolderFixture />;
  }
  if (window.location.pathname === "/build-pipeline-header") {
    return <BuildPipelineHeaderFixture />;
  }
  if (window.location.pathname === "/change-tracking") return <ChangeTrackingFixture />;
  if (window.location.pathname === "/diff-viewer") return <DiffViewerFixture />;
  if (window.location.pathname === "/native-compose") return <NativeComposeFixture />;
  if (window.location.pathname === "/menu-placement") return <MenuPlacementFixture />;
  if (window.location.pathname === "/composer-icon-pickers") return <ComposerIconPickersFixture />;
  if (window.location.pathname === "/agent-model-picker") return <AgentModelPickerFixture />;
  if (window.location.pathname === "/mobile-shell") return <MobileAppShellFixture />;
  if (window.location.pathname === "/environment-settings-drawer") {
    return (
      <Suspense fallback={null}>
        <EnvironmentSettingsDrawerFixture />
      </Suspense>
    );
  }
  if (window.location.pathname === "/path-truncation") return <PathTruncationFixture />;
  if (window.location.pathname === "/multi-review-launch") {
    return <MultiReviewLaunchDialogFixture />;
  }
  if (window.location.pathname === "/multi-review-auto-fix") {
    return <MultiReviewAutoFixFixture />;
  }
  if (window.location.pathname === "/multi-review-overview") {
    return <MultiReviewOverviewFixture />;
  }
  if (window.location.pathname === "/multi-review-running-tile") {
    return <MultiReviewRunningTileFixture />;
  }
  if (window.location.pathname === "/multi-review-flow") return <MultiReviewFlowFixture />;
  if (window.location.pathname === "/agent-launch") return <AgentLaunchDialogFixture />;
  if (window.location.pathname === "/review-launch") return <ReviewLaunchDialogFixture />;
  if (window.location.pathname === "/review-validation-output") {
    return <ReviewValidationOutputFixture />;
  }
  if (window.location.pathname === "/native-refresh-shimmer") {
    return <NativeRefreshShimmerFixture />;
  }
  if (window.location.pathname === "/native-held-send") {
    return (
      <Suspense fallback={null}>
        <NativeHeldSendFixture />
      </Suspense>
    );
  }
  if (window.location.pathname === "/native-hydrating-preview") {
    return <NativeHydratingPreviewFixture />;
  }
  if (window.location.pathname === "/native-attachments") return <NativeAttachmentsFixture />;
  if (window.location.pathname === "/monaco-runtime") return <MonacoRuntimeFixture />;
  if (window.location.pathname === "/claude-interactions") return <ClaudeInteractionsFixture />;
  if (window.location.pathname === "/styles") return <GlobalStylesFixture />;
  if (window.location.pathname === "/markdown-editor") return <MarkdownEditorFixture />;
  if (window.location.pathname === "/system-usage") return <SystemUsageFixture />;
  if (window.location.pathname === "/pr-check-status") {
    return <PullRequestCheckStatusFixture />;
  }
  if (window.location.pathname === "/workspace-bar-height") {
    return <WorkspaceBarHeightFixture />;
  }
  if (window.location.pathname === "/transcript-paging")
    return (
      <Suspense fallback={null}>
        <TranscriptPagingFixture />
      </Suspense>
    );
  if (window.location.pathname === "/rich-transcript-perf")
    return (
      <Suspense fallback={null}>
        <RichTranscriptPerfFixture />
      </Suspense>
    );
  if (window.location.pathname === "/design-library-perf")
    return (
      <Suspense fallback={null}>
        <DesignLibraryPerfFixture />
      </Suspense>
    );
  if (window.location.pathname === "/virtuoso-follow") return <VirtuosoFollowFixture />;
  if (window.location.pathname === "/agent-usage") return <AgentUsageFixture />;
  if (window.location.pathname === "/background-task-outcome")
    return <BackgroundTaskOutcomeFixture />;
  if (window.location.pathname === "/codex-subagent-cards") return <CodexSubagentCardsFixture />;
  if (window.location.pathname === "/opencode-pipeline-transcript")
    return <OpenCodePipelineTranscriptFixture />;
  if (window.location.pathname === "/streaming-transcript") return <StreamingTranscriptFixture />;
  if (window.location.pathname === "/tmux-compose-focus") return <TmuxComposeFocusFixture />;
  if (window.location.pathname === "/read-coordinator") return <ReadCoordinatorFixture />;
  return <CreateEnvironmentFixture />;
}

if (window.location.pathname === "/change-tracking") installChangeTrackingFixture();
createRoot(document.getElementById("root")!).render(<StrictMode>{fixtureForPath()}</StrictMode>);
