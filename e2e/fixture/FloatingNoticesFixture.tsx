import { useLayoutEffect, useState } from "react";
import type {
  AgentMailMailboxSnapshot,
  AgentMailMessageSummary,
} from "@orkestrator/protocol/agent-mail";
import type { HumanPromptEntry } from "@orkestrator/protocol/human-prompts";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import { CoordinatorConversationPane } from "../../apps/web/src/components/projects/CoordinatorConversationPane";
import { CoordinatorPaneTree } from "../../apps/web/src/components/projects/CoordinatorPaneTree";
import {
  focusCoordinatorPane,
  type CoordinatorPaneLayout,
} from "../../apps/web/src/lib/coordinator-pane-layout";
import { AgentMailBanner } from "../../apps/web/src/components/agent-mail/AgentMailBanner";
import { HumanPromptBanner } from "../../apps/web/src/components/chat/HumanPromptBanner";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import {
  CoordinatorBanner,
  CoordinatorWorkflowStoreBanner,
} from "../../apps/web/src/components/projects/CoordinatorPanelNotices";
import { InitializationLogs } from "../../apps/web/src/components/terminal/InitializationLogs";
import { RenderedRawFileShell } from "../../apps/web/src/components/terminal/RenderedRawFileShell";
import { Button } from "../../apps/web/src/components/ui/button";
import {
  AGENT_TAB_NOTICE_POSITION,
  FLOATING_NOTICE_ACTION,
  FloatingNotice,
  FloatingNoticeLayer,
  TRANSCRIPT_COLUMN_REM,
} from "../../apps/web/src/components/ui/floating-notice";
import type { NativeMessage as Message } from "../../apps/web/src/lib/chat/native-message-types";
import { useAgentMailStore } from "../../apps/web/src/stores/agentMailStore";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";

const ENVIRONMENT = "env-floating";
const TAB = "tab-floating";
const MAILBOX = `${ENVIRONMENT}\0${TAB}`;

function seedMail() {
  const message: AgentMailMessageSummary = {
    version: 1,
    id: "mail-1",
    threadId: "thread-1",
    requestId: "request-1",
    createdAt: new Date().toISOString(),
    from: {
      kind: "tab",
      projectId: "project-1",
      environmentId: "env-reviewer",
      tabId: "tab-reviewer",
      incarnationId: "incarnation-2",
      agent: "codex",
      title: "Codex 1",
    },
    toEnvironmentId: ENVIRONMENT,
    toTabId: TAB,
    toIncarnationId: "incarnation-1",
    subject: "Review findings for the login form",
    bodyBytes: 120,
    trust: "same-project",
    injectDepth: 0,
    threadDepth: 0,
    placement: "stored",
    revision: 1,
  } as AgentMailMessageSummary;
  const snapshot = {
    descriptor: {
      mailboxId: MAILBOX,
      incarnationId: "incarnation-1",
      projectId: "project-1",
      projectName: "origin",
      environmentId: ENVIRONMENT,
      environmentName: "fix-login",
      environmentStatus: "running",
      tabId: TAB,
      tabType: "agent-native",
      title: "Claude 2",
      displayName: "Claude 2",
      tabOrdinal: 2,
      agent: "claude",
      kind: "native",
      presence: "idle",
      injectPolicy: "off",
      injectOverride: "off",
      mutedInbound: false,
      mutedOutbound: false,
      unreadCount: 1,
      userUnseenCount: 1,
      agentUnackedCount: 1,
      pendingInjectCount: 0,
      failedInjectCount: 0,
      capabilities: { canPull: true, canSend: true, canInject: true },
    },
    messages: [message],
    total: 1,
    offset: 0,
    limit: 100,
    revision: 1,
  } as AgentMailMailboxSnapshot;
  appCommandStore(useAgentMailStore.def).setState({
    revision: 1,
    summary: new Map([
      [
        MAILBOX,
        {
          mailboxId: MAILBOX,
          projectId: "project-1",
          environmentId: ENVIRONMENT,
          tabId: TAB,
          unreadCount: 1,
          userUnseenCount: 1,
          agentUnackedCount: 1,
          pendingInjectCount: 0,
          failedInjectCount: 0,
          revision: 1,
        },
      ],
    ]),
    mailboxes: new Map([[MAILBOX, snapshot]]),
    refreshSummary: async () => undefined,
    refreshMailbox: async () => undefined,
  });
}

const signIn: HumanPromptEntry = {
  id: "prompt-1",
  environmentId: ENVIRONMENT,
  tabId: TAB,
  source: "agent-tool",
  since: "2026-11-05T10:00:00.000Z",
  command: "gh auth login",
  prompt: {
    kind: "device-code",
    url: "https://github.com/login/device",
    code: "1A2B-3C4D",
    wantsEnter: false,
    text: "Enter the code",
    key: "device",
  },
} as HumanPromptEntry;

const paragraph =
  "The login form keeps its submit button enabled while the request is pending, so a double click sends two requests. I added a pending state that disables the button and shows a spinner, and the error text is now announced through a polite live region.";

const transcript: Message[] = [
  {
    id: "user-1",
    role: "user",
    content: "Fix the login form findings from the review and run the tests.",
    createdAt: "2026-11-05T10:00:00.000Z",
    parts: [
      { type: "text", content: "Fix the login form findings from the review and run the tests." },
    ],
  },
  ...Array.from({ length: 4 }, (_, index) => ({
    id: `assistant-${index}`,
    role: "assistant" as const,
    content: paragraph,
    createdAt: "2026-11-05T10:01:00.000Z",
    parts: [{ type: "text" as const, content: `${paragraph}\n\n${paragraph}` }],
  })),
];

function Transcript() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        data-testid="transcript-column"
        className="mx-auto w-full max-w-[56rem] space-y-4 px-2 py-6 sm:w-[min(calc(100%_-_2rem),56rem)]"
      >
        {transcript.map((message) => (
          <NativeMessage key={message.id} platform="claude" message={message} />
        ))}
      </div>
    </div>
  );
}

function TabBar({ title }: { title: string }) {
  return (
    <div className="flex h-8 shrink-0 items-end border-b border-border px-2 text-xs">
      <span className="border-b-2 border-primary px-3 pb-1.5 text-foreground">{title}</span>
    </div>
  );
}

function AgentScene() {
  const [seeded] = useState(() => {
    seedMail();
    return true;
  });
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <TabBar title="Claude 2" />
      {seeded ? (
        <FloatingNoticeLayer
          columnRem={TRANSCRIPT_COLUMN_REM}
          anchorClassName={AGENT_TAB_NOTICE_POSITION}
        >
          <AgentMailBanner environmentId={ENVIRONMENT} tabId={TAB} />
          <HumanPromptBanner prompts={[signIn]} />
          <Transcript />
        </FloatingNoticeLayer>
      ) : null}
    </div>
  );
}

function CoordinatorScene() {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <TabBar title="Coordinator" />
      <FloatingNoticeLayer
        columnRem={TRANSCRIPT_COLUMN_REM}
        anchorClassName={AGENT_TAB_NOTICE_POSITION}
      >
        <CoordinatorWorkflowStoreBanner state="near-limit" />
        <CoordinatorBanner
          tone="warning"
          label="Agent unavailable"
          summary="Codex is unavailable for Coordinator."
          action={
            <>
              <Button size="sm" variant="secondary" className={FLOATING_NOTICE_ACTION}>
                Coordinator settings
              </Button>
              <Button size="sm" variant="ghost" className={FLOATING_NOTICE_ACTION}>
                Retry
              </Button>
            </>
          }
        >
          <span className="font-medium">Codex is unavailable for Coordinator.</span>{" "}
          <span className="text-muted-foreground">Codex is signed out on this machine.</span>
        </CoordinatorBanner>
        <Transcript />
      </FloatingNoticeLayer>
    </div>
  );
}

const coordinatorSnapshot: CoordinatorSnapshot = {
  workspace: {
    version: 1,
    id: "notice-coordinator",
    projectId: "project-1",
    executionPolicy: "coordinator-read-only",
    lifecycleState: "ready",
    conversations: [],
    selectedConversationId: "first",
    repositoryContextRevision: 0,
    createdAt: "2026-11-06T00:00:00Z",
    updatedAt: "2026-11-06T00:00:00Z",
  },
  projectPath: "/fixture",
  providerAvailability: {
    codex: {
      tier: "enforced",
      available: false,
      delegation: true,
      reason: "Fixture provider unavailable.",
    },
  },
  controlMcp: { enabled: false, running: false, error: null },
  workflows: [],
};

function CoordinatorSplitScene() {
  const [layout, setLayout] = useState<CoordinatorPaneLayout>({
    activePaneId: "first-pane",
    root: {
      kind: "split",
      id: "split",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        {
          kind: "leaf",
          id: "first-pane",
          conversationIds: ["first"],
          activeConversationId: "first",
        },
        {
          kind: "leaf",
          id: "second-pane",
          conversationIds: ["second"],
          activeConversationId: "second",
        },
      ],
    },
  });
  return (
    <div className="relative min-h-0 flex-1">
      <FloatingNoticeLayer>
        <CoordinatorBanner tone="info" label="Panel notice" summary="Shared panel notice">
          Shared panel notice
        </CoordinatorBanner>
        <CoordinatorPaneTree
          layout={layout}
          onLayoutChange={(change) => setLayout(change)}
          onFocusPane={(id) => setLayout((current) => focusCoordinatorPane(current, id))}
          conversationLabel={(id) => id}
          renderStripActions={() => null}
          renderTab={(id, pane) => (
            <button key={id} role="tab" id={`coordinator-tab-${pane.id}-${id}`}>
              {id}
            </button>
          )}
          renderContent={(pane, focused) => (
            <CoordinatorConversationPane
              conversation={{
                id: pane.activeConversationId!,
                title: pane.activeConversationId!,
                tabId: pane.id,
                logicalSessionKey: pane.id,
                agent: pane.activeConversationId === "first" ? undefined : "codex",
                role: pane.activeConversationId === "first" ? "main" : "side",
                createdAt: "2026-11-06T00:00:00Z",
                mailboxIncarnationId: pane.id,
                startupError: `${pane.activeConversationId} failed to start`,
              }}
              paneFocused={focused}
              projectId="project-1"
              snapshot={coordinatorSnapshot}
              availablePlatforms={[]}
              platformNotes={{}}
              platformBadges={{}}
              launch={undefined}
              startConversation={async () => {}}
              confirmUpstreamMerge={async () => undefined}
              conversationBusy={false}
              newConversationLabel="New conversation"
              onCreateConversation={() => {}}
              onRetry={() => {}}
              onRetryConversation={() => {}}
              onCloseConversation={() => {}}
            />
          )}
        />
      </FloatingNoticeLayer>
    </div>
  );
}

function ConstrainedScene({ narrow = false }: { narrow?: boolean }) {
  const [actions, setActions] = useState(0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <output aria-label="Completed notice actions">{actions}</output>
      <div
        className="relative flex h-[220px] shrink-0 flex-col overflow-hidden border border-border"
        style={{ width: narrow ? 128 : "100%" }}
        data-testid="constrained-pane"
      >
        <FloatingNoticeLayer columnRem={TRANSCRIPT_COLUMN_REM}>
          <HumanPromptBanner
            prompts={Array.from({ length: 12 }, (_, index) => ({
              ...signIn,
              id: `long-${index}`,
              command: `command ${index}`,
            }))}
          />
          {["First long notice", "Second long notice"].map((label) => (
            <FloatingNotice
              label={label}
              summary="A long notice requiring attention"
              key={label}
              actions={
                <Button onClick={() => setActions((count) => count + 1)}>Resolve {label}</Button>
              }
            >
              {Array.from({ length: 12 }, (_, index) => (
                <p key={index}>Notice detail {index + 1}</p>
              ))}
            </FloatingNotice>
          ))}
          <Transcript />
        </FloatingNoticeLayer>
      </div>
    </div>
  );
}

function LiveAnnouncementsScene() {
  const [revision, setRevision] = useState(0);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" style={{ maxWidth: 390 }}>
      <div className="flex gap-2">
        <Button onClick={() => setRevision((value) => value + 1)}>Update notices</Button>
      </div>
      <FloatingNoticeLayer columnRem={TRANSCRIPT_COLUMN_REM}>
        {revision > 0 && (
          <>
            <HumanPromptBanner
              prompts={[
                {
                  ...signIn,
                  prompt: { ...signIn.prompt, kind: revision === 1 ? "device-code" : "sign-in" },
                },
              ]}
            />
            <CoordinatorBanner
              tone="error"
              label="Action failed"
              summary={`Attempt ${revision} failed`}
            >
              Attempt {revision} failed
            </CoordinatorBanner>
          </>
        )}
        <Transcript />
      </FloatingNoticeLayer>
    </div>
  );
}

function LogsScene() {
  // The first read succeeds; every later one fails, so the view goes stale.
  useLayoutEffect(() => {
    const original = window.orkestrator;
    let reads = 0;
    window.orkestrator = {
      invoke: async <T,>(command: string) => {
        if (command !== "get_container_logs") return undefined as T;
        reads += 1;
        if (reads === 1) {
          return Array.from(
            { length: 30 },
            (_, index) => `[setup] step ${index + 1}: installing workspace dependencies`,
          ).join("\n") as T;
        }
        throw new Error("Docker did not answer");
      },
      listen: () => () => undefined,
    } as unknown as Window["orkestrator"];
    return () => {
      window.orkestrator = original;
    };
  }, []);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <InitializationLogs containerId="container-1" pollIntervalMs={150} className="h-full" />
    </div>
  );
}

function FileIcon({ className }: { className?: string }) {
  return <span aria-hidden="true" className={className} />;
}

const rawMarkdown = Array.from(
  { length: 40 },
  (_, index) =>
    `| row ${index + 1} | ${"a table row the rendered mode cannot round-trip ".repeat(2)} |`,
).join("\n");

function MarkdownScene() {
  return (
    <div className="relative min-h-0 flex-1">
      <RenderedRawFileShell
        mode="raw"
        onModeChange={() => undefined}
        icon={FileIcon}
        filePath="docs/notes.md"
        language="markdown"
        value={rawMarkdown}
        isActive
        isSaving={false}
        onChange={() => undefined}
        onSave={async () => true}
        notice={
          // The notice MarkdownEditorTab passes when rendered mode is unavailable.
          <FloatingNotice
            tone="warning"
            label="Raw mode only"
            summary="Rendered mode is unavailable for this file."
          >
            Rendered mode is unavailable for this file: a table cell holds a pipe the editor cannot
            keep.
          </FloatingNotice>
        }
      >
        <div />
      </RenderedRawFileShell>
    </div>
  );
}

/** Floating notices over the panes that show them, for layout checks and screenshots. */
export function FloatingNoticesFixture() {
  const scene = new URLSearchParams(window.location.search).get("scene") ?? "agent";
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      {scene === "live" ? (
        <LiveAnnouncementsScene />
      ) : scene === "coordinator-split" ? (
        <CoordinatorSplitScene />
      ) : scene === "short" ? (
        <ConstrainedScene />
      ) : scene === "narrow" ? (
        <ConstrainedScene narrow />
      ) : scene === "coordinator" ? (
        <CoordinatorScene />
      ) : scene === "logs" ? (
        <LogsScene />
      ) : scene === "markdown" ? (
        <MarkdownScene />
      ) : (
        <AgentScene />
      )}
    </main>
  );
}
