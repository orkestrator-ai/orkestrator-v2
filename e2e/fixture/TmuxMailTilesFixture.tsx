import { renderAgentMailCarrier, type AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { ClaudeTmuxChatTab } from "../../apps/web/src/components/claude/ClaudeTmuxChatTab";

// The real tmux tab over a canned backend, with no tmux and no provider: its
// transcript is JSONL records as Claude Code writes them, so a reload rebuilds
// every row from the same records.

const TIME = "2026-11-05T10:04:00.000Z";

function mail(overrides: Partial<AgentMailMessage>): string {
  return renderAgentMailCarrier({
    version: 1,
    id: "mail",
    threadId: "mail",
    requestId: "request",
    createdAt: TIME,
    from: {
      kind: "tab",
      projectId: "project",
      environmentId: "worker",
      tabId: "startup-agent",
      incarnationId: "incarnation",
      agent: "codex",
      title: "Codex 1 · parser-fix worker",
    },
    toEnvironmentId: "tmux-environment",
    toTabId: "tmux-tab",
    toIncarnationId: "incarnation",
    body: "Fixed the tokenizer so nested quotes no longer end a string early.\n\n- Added cases for escaped quotes\n- Ran `bun test` (412 passed)",
    bodyBytes: 100,
    trust: "same-project",
    injectDepth: 0,
    threadDepth: 0,
    placement: "injected",
    revision: 1,
    ...overrides,
  });
}

const BATCH = [
  mail({ id: "worker-report", subject: "Parser fixed, ready for review" }),
  mail({
    id: "review-ready",
    from: { kind: "system", projectId: "project", source: "workflow", resourceId: "review-1" },
    subject: "Multi Review ready: 3 findings",
    body: "Multi Review `review-1` consolidated **3 findings**.",
    notice: {
      resource: { kind: "multi-review", id: "review-1", environmentId: "worker" },
      state: "ready",
      tone: "info",
    },
  }),
].join("\n\n");

const UNREADABLE =
  '<orkestrator-peer-message version="1">\n<orkestrator-peer-payload-json>\n{not json}\n' +
  "</orkestrator-peer-payload-json>\n</orkestrator-peer-message>";

function record(uuid: string, role: "user" | "assistant", content: unknown) {
  return { type: role, uuid, timestamp: TIME, message: { role, content } };
}

const TRANSCRIPT = [
  record("typed", "user", "Please wait for the parser worker's report."),
  record("reply", "assistant", [{ type: "text", text: "Waiting for its report." }]),
  record("delivered", "user", BATCH),
  record("answer", "assistant", [{ type: "text", text: "The report arrived; reading it now." }]),
  record("delivered-blocks", "user", [
    {
      type: "text",
      // tmux pastes a line feed as a carriage return.
      text: mail({ id: "follow-up", subject: "One more thing" }).replaceAll("\n", "\r"),
    },
  ]),
  record("delivered-broken", "user", UNREADABLE),
];

const CANNED_RESPONSES: Record<string, unknown> = {
  claude_tmux_status: {
    tab_id: "tmux-tab",
    environment_id: "tmux-environment",
    session_id: "fixture-session",
    tmux_session: "fixture",
    running: true,
    transcript_path: "/fixture/session.jsonl",
    resumed: false,
    busy: false,
    permission_mode: "bypassPermissions",
    fast_mode: false,
  },
  claude_tmux_transcript: { lines: TRANSCRIPT, earlierCursor: null },
  claude_tmux_pending_hooks: [],
  claude_tmux_tasks: { tasks: [] },
};

/** Installed before the fixture renders. */
export function installTmuxMailTilesFixture() {
  window.orkestrator = {
    invoke: async <T,>(command: string) => (CANNED_RESPONSES[command] ?? null) as T,
    listen: () => () => {},
    clipboard: {
      readText: async () => "",
      writeText: async () => {},
      readImage: async () => null,
      writeImage: async () => {},
    },
    process: { exit: async () => {} },
    window: { startDragging: async () => {} },
  };
}

export function TmuxMailTilesFixture() {
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <ClaudeTmuxChatTab tabId="tmux-tab" data={{ environmentId: "tmux-environment" }} isActive />
    </main>
  );
}
