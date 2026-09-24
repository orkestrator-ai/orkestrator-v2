import { DesignCanvasFixture } from "./DesignCanvasFixture";
import { MenuPlacementFixture } from "./MenuPlacementFixture";
import { ReadCoordinatorFixture } from "./ReadCoordinatorFixture";
import { StreamingTranscriptFixture } from "./StreamingTranscriptFixture";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { StrictMode, createRef, useEffect, useRef, useState } from "react";
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
    usePaneLayoutStore.setState((state) => ({
      hydration: new Map(state.hydration).set("design-fixture", "done"),
    }));
  }, []);

  window.orkestrator = {
    invoke: async <T,>(command: string) => {
      if (command === "design_status") return { ready: true } as T;
      if (command === "design_action") return [] as T;
      throw new Error(`Unexpected fixture command: ${command}`);
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
          attachments={[]}
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

function PathTruncationFixture() {
  window.orkestrator = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      if (command !== "read_container_file") {
        throw new Error(`Unexpected fixture command: ${command}`);
      }

      return {
        path: String(args?.filePath ?? ""),
        content: "export {};",
        language: "typescript",
      } as T;
    },
  } as Window["orkestrator"];

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
            filePath={filePath}
            containerId="fixture-container"
            baseBranch="main"
            gitStatus="A"
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

const diffFixtureOriginal = [
  "# Frontend State Audit",
  "",
  "**Goal:** minimise renderer-owned state so that every client of the same backend",
  "converges on a consistent view.",
  "",
  "## 1. Current architecture",
  "",
  "The backend already owns a lot. Storage persists projects, environments and review",
  "workflows, plus kanban tasks and completion-comment markers.",
  "",
  "### The gap",
  "",
  "Two things are missing, and every finding below is downstream of them.",
].join("\n");

const diffFixtureModified = [
  "# Frontend State Audit — What Should Move",
  "",
  "**Goal:** minimise renderer-owned state so that every client of the same backend",
  "converges on a consistent view of the world.",
  "",
  "## 1. Current architecture",
  "",
  "The backend already owns a lot. `StorageService` persists projects, environments,",
  "config, review workflows, kanban tasks and completion-comment markers.",
  "",
  "### The gap",
  "",
  "Two things are missing, and every finding below is downstream of them.",
  "",
  "**(a) There is no general change-notification broadcast** — only a fixed set of",
  "event names is ever emitted across the whole surface:",
  "",
  "```",
  "environment-renamed",
  "environment-setup-started",
  "claude-model-catalog-updated",
  "```",
].join("\n");

/**
 * Renders the diff viewer at full height so the phone layout (inline mode, wrapped
 * lines, trimmed gutters) can be inspected at a real mobile viewport.
 */
function DiffViewerFixture() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  const gitStatus = status === "new" ? "A" : status === "deleted" ? "D" : "M";
  const filePath = "docs/audits/frontend-state-audit.md";
  const containerId = "fixture-container";
  const baseBranch = params.get("branch") ?? "63d12576e9198f24bc2271a6a8c3702dfb391eae";
  const [viewFileCount, setViewFileCount] = useState(0);

  window.orkestrator = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case "read_container_file":
          assertFixtureArgs(command, args, { containerId, filePath });
          return {
            path: filePath,
            content: diffFixtureModified,
            language: "markdown",
          } as T;
        case "read_file_at_branch":
          assertFixtureArgs(command, args, { containerId, filePath, branch: baseBranch });
          return {
            path: filePath,
            content: diffFixtureOriginal,
            language: "markdown",
          } as T;
        default:
          throw new Error(`Unexpected fixture command: ${command}`);
      }
    },
  } as Window["orkestrator"];

  return (
    <main className="h-screen bg-background text-foreground">
      <section data-testid="diff-viewer-pane" className="relative h-full w-full">
        <DiffViewerTab
          filePath={filePath}
          containerId={containerId}
          baseBranch={baseBranch}
          gitStatus={gitStatus}
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
        {...scrollProps}
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
  if (window.location.pathname === "/design-canvas") return <DesignCanvasFixture />;
  if (window.location.pathname === "/design-launch") return <DesignLaunchFixture />;
  if (window.location.pathname === "/browser") return <BrowserFixture />;
  if (window.location.pathname === "/sortable-project-folder") {
    return <SortableProjectFolderFixture />;
  }
  if (window.location.pathname === "/build-pipeline-header") {
    return <BuildPipelineHeaderFixture />;
  }
  if (window.location.pathname === "/diff-viewer") return <DiffViewerFixture />;
  if (window.location.pathname === "/native-compose") return <NativeComposeFixture />;
  if (window.location.pathname === "/menu-placement") return <MenuPlacementFixture />;
  if (window.location.pathname === "/agent-model-picker") return <AgentModelPickerFixture />;
  if (window.location.pathname === "/mobile-shell") return <MobileAppShellFixture />;
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
  if (window.location.pathname === "/review-launch") return <ReviewLaunchDialogFixture />;
  if (window.location.pathname === "/review-validation-output") {
    return <ReviewValidationOutputFixture />;
  }
  if (window.location.pathname === "/native-refresh-shimmer") {
    return <NativeRefreshShimmerFixture />;
  }
  if (window.location.pathname === "/native-hydrating-preview") {
    return <NativeHydratingPreviewFixture />;
  }
  if (window.location.pathname === "/monaco-runtime") return <MonacoRuntimeFixture />;
  if (window.location.pathname === "/styles") return <GlobalStylesFixture />;
  if (window.location.pathname === "/system-usage") return <SystemUsageFixture />;
  if (window.location.pathname === "/pr-check-status") {
    return <PullRequestCheckStatusFixture />;
  }
  if (window.location.pathname === "/workspace-bar-height") {
    return <WorkspaceBarHeightFixture />;
  }
  if (window.location.pathname === "/virtuoso-follow") return <VirtuosoFollowFixture />;
  if (window.location.pathname === "/streaming-transcript") return <StreamingTranscriptFixture />;
  if (window.location.pathname === "/read-coordinator") return <ReadCoordinatorFixture />;
  return <CreateEnvironmentFixture />;
}

createRoot(document.getElementById("root")!).render(<StrictMode>{fixtureForPath()}</StrictMode>);
