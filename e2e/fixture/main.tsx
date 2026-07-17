import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../apps/web/src/index.css";
import {
  CreateEnvironmentDialog,
  type ClaudeOptions,
} from "../../apps/web/src/components/environments/CreateEnvironmentDialog";
import { BrowserTab } from "../../apps/web/src/components/browser/BrowserTab";
import { CodexComposeBar } from "../../apps/web/src/components/codex/CodexComposeBar";

declare global {
  interface Window {
    lastCreateEnvironmentOptions?: ClaudeOptions;
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

function GlobalStylesFixture() {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
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
      <div data-testid="dropdown-content" data-slot="dropdown-menu-content">Dropdown</div>
      <div data-testid="context-content" data-slot="context-menu-content">Context</div>
      <div data-testid="dropdown-item" data-slot="dropdown-menu-item">Dropdown item</div>
      <div data-testid="context-item" data-slot="context-menu-item">Context item</div>
    </main>
  );
}

function fixtureForPath() {
  if (window.location.pathname === "/browser") return <BrowserFixture />;
  if (window.location.pathname === "/codex-compose") return <CodexComposeFixture />;
  if (window.location.pathname === "/styles") return <GlobalStylesFixture />;
  return <CreateEnvironmentFixture />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {fixtureForPath()}
  </StrictMode>,
);
