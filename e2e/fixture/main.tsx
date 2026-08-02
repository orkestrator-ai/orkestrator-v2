import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../apps/web/src/index.css";
import {
  CreateEnvironmentDialog,
  type ClaudeOptions,
} from "../../apps/web/src/components/environments/CreateEnvironmentDialog";
import { BrowserTab } from "../../apps/web/src/components/browser/BrowserTab";
import { CodexComposeBar } from "../../apps/web/src/components/codex/CodexComposeBar";
import { AgentThinkingIndicator } from "../../apps/web/src/components/chat/AgentThinkingIndicator";
import { MessageShell } from "../../apps/web/src/components/chat/MessageShell";
import { MentionableInput } from "../../apps/web/src/components/chat/MentionableInput";
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
        defaultPortMappings={[
          { containerPort: 3000, hostPort: 3000, protocol: "tcp" },
        ]}
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

function CodexComposeFixture() {
  const [fastModeEnabled, setFastModeEnabled] = useState(false);
  const [sentCount, setSentCount] = useState(0);

  return (
    <main className="min-h-screen bg-background pt-4 text-foreground">
      <section data-testid="codex-compose-fixture" className="w-full">
        <CodexComposeBar
          environmentId="codex-compose-fixture"
          sessionKey="codex-compose-fixture-session"
          models={[{
            id: "long-model",
            name: "A deliberately long Codex model name for narrow viewport coverage",
            reasoningEfforts: ["medium", "high"],
          }]}
          selectedMode="build"
          selectedModel="long-model"
          selectedReasoningEffort="high"
          fastModeEnabled={fastModeEnabled}
          queueLength={123}
          showAddressAll
          onSend={async () => setSentCount((count) => count + 1)}
          onQueue={() => {}}
          onStop={async () => {}}
          onModeChange={() => {}}
          onModelChange={() => {}}
          onReasoningEffortChange={() => {}}
          onFastModeChange={setFastModeEnabled}
        />
        <output data-testid="codex-send-count">{sentCount}</output>
      </section>
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
        defaultTabType="claude-native"
        catalog={reviewModelCatalog}
        onConfirm={(nextSelection) => {
          setSelection(nextSelection);
          setOpen(false);
        }}
      />
    </main>
  );
}

function GlobalStylesFixture() {
  const twelveLineDraft = Array.from(
    { length: 12 },
    (_, index) => `Line ${index + 1}`,
  ).join("\n");
  const thirteenLineDraft = `${twelveLineDraft}\nLine 13`;

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <AgentThinkingIndicator agentName="Codex" />
      <div data-testid="chat-status-row" className="chat-status-row">
        <span data-testid="chat-status-content">Completed</span>
      </div>
      <section data-testid="assistant-message-shell">
        <MessageShell
          isUser={false}
          authorLabel="Assistant"
          timestampLabel="1:00 PM"
          actions={<button data-testid="assistant-message-action" type="button">Copy</button>}
        >
          <p>Assistant message</p>
        </MessageShell>
      </section>
      <section data-testid="user-message-shell">
        <MessageShell
          isUser={true}
          authorLabel="You"
          timestampLabel="1:01 PM"
          actions={<button data-testid="user-message-action" type="button">Fork</button>}
        >
          <p>User message</p>
        </MessageShell>
      </section>
      <div data-testid="sidebar-glass" className="sidebar-glass">Sidebar</div>
      <div data-testid="panel-surface" className="panel-surface">Panel</div>
      <div data-testid="drag-region" data-backend-drag-region>Drag region</div>
      <div data-testid="no-select" className="no-select">No selection</div>
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
      <div
        data-testid="scroll-host"
        className="h-20 w-20 overflow-scroll"
      >
        <div className="h-40 w-40" />
      </div>
      <div data-mobile-toolbar>
        <button data-testid="mobile-toolbar-button" type="button">Tool</button>
      </div>
      <div className="mobile-sidebar">
        <div data-testid="mobile-sidebar-header" data-sidebar-header>Mobile sidebar</div>
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
      <div data-testid="dropdown-content" data-slot="dropdown-menu-content">Dropdown</div>
      <div data-testid="context-content" data-slot="context-menu-content">Context</div>
      <div data-testid="dropdown-item" data-slot="dropdown-menu-item">Dropdown item</div>
      <div data-testid="context-item" data-slot="context-menu-item">Context item</div>
    </main>
  );
}

const mobileShellTitle =
  "A project and environment name that is far too long for a mobile title bar";

function MobileAppShellFixture() {
  const [dragStarts, setDragStarts] = useState(0);
  const desktop = new URLSearchParams(window.location.search).has("desktop");

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
        agentInfoButton={<button type="button">Agent info</button>}
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
} as const;

const changedFileFixture = {
  path: pathFixtures.posix,
  directory: "packages/a-very-long-directory-name/src/components",
  filename: "ImportantButton.tsx",
  additions: 0,
  deletions: 0,
  status: "M",
} satisfies GitFileChange;

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
      <section
        data-testid="changed-file-path-pane"
        className="mb-4 border border-border"
        style={{ width: "640px" }}
      >
        <ChangedFileItem change={changedFileFixture} />
      </section>
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
  const baseBranch =
    params.get("branch") ?? "63d12576e9198f24bc2271a6a8c3702dfb391eae";
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
  if (window.location.pathname === "/codex-compose") return <CodexComposeFixture />;
  if (window.location.pathname === "/mobile-shell") return <MobileAppShellFixture />;
  if (window.location.pathname === "/path-truncation") return <PathTruncationFixture />;
  if (window.location.pathname === "/review-launch") return <ReviewLaunchDialogFixture />;
  if (window.location.pathname === "/styles") return <GlobalStylesFixture />;
  return <CreateEnvironmentFixture />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {fixtureForPath()}
  </StrictMode>,
);
