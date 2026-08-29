import type { VirtuosoHandle } from "react-virtuoso";
import { StrictMode, createRef, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../apps/web/src/index.css";
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
import { ChangedFileItem } from "../../apps/web/src/components/files-panel/ChangedFileItem";
import { MobileAppShellLayout } from "../../apps/web/src/components/layout/MobileAppShellLayout";
import {
  ReviewLaunchDialog,
  type ReviewLaunchSelection,
  type ReviewModelCatalog,
} from "../../apps/web/src/components/review/ReviewLaunchDialog";
import { MultiReviewLaunchDialog } from "../../apps/web/src/components/review/MultiReviewLaunchDialog";
import type { GitFileChange } from "../../apps/web/src/lib/backend";

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

function fixtureForPath() {
  if (window.location.pathname === "/browser") return <BrowserFixture />;
  if (window.location.pathname === "/diff-viewer") return <DiffViewerFixture />;
  if (window.location.pathname === "/native-compose") return <NativeComposeFixture />;
  if (window.location.pathname === "/agent-model-picker") return <AgentModelPickerFixture />;
  if (window.location.pathname === "/mobile-shell") return <MobileAppShellFixture />;
  if (window.location.pathname === "/path-truncation") return <PathTruncationFixture />;
  if (window.location.pathname === "/multi-review-launch") {
    return <MultiReviewLaunchDialogFixture />;
  }
  if (window.location.pathname === "/review-launch") return <ReviewLaunchDialogFixture />;
  if (window.location.pathname === "/styles") return <GlobalStylesFixture />;
  return <CreateEnvironmentFixture />;
}

createRoot(document.getElementById("root")!).render(<StrictMode>{fixtureForPath()}</StrictMode>);
