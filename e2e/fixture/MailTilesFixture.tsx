import { useState } from "react";
import { renderAgentMailCarrier, type AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import { createPeerMailNativeMessagesFromCarrier } from "../../apps/web/src/lib/chat/client-only-messages";

const REPORT = [
  "## Parser fix",
  "",
  "Fixed the tokenizer so nested quotes no longer end a string early.",
  "",
  "- Added `tokenizer.test.ts` cases for escaped quotes",
  "- Ran `bun test` (412 passed)",
  "- Opened [the pull request](https://example.com/pr/12)",
  "",
  ...Array.from({ length: 10 }, (_, index) => `Detail line ${index + 1} of the full report.`),
].join("\n");

function message(overrides: Partial<AgentMailMessage>): AgentMailMessage {
  return {
    version: 1,
    id: "mail",
    threadId: "mail",
    requestId: "request",
    createdAt: "2026-10-16T10:04:00.000Z",
    from: {
      kind: "tab",
      projectId: "project",
      environmentId: "worker",
      tabId: "startup-agent",
      incarnationId: "incarnation",
      agent: "codex",
      title: "Codex 1 · parser-fix worker with a long environment name",
    },
    toEnvironmentId: "coordinator:c:v",
    toTabId: "coordinator-v",
    toIncarnationId: "incarnation",
    body: REPORT,
    bodyBytes: REPORT.length,
    trust: "same-project",
    injectDepth: 0,
    threadDepth: 0,
    placement: "injected",
    revision: 1,
    ...overrides,
  };
}

const workflow = { kind: "system", projectId: "project", source: "workflow" } as const;

// One injected prompt carrying three batched messages, exactly as the drain
// writes it and a provider echoes it back.
const BATCH = [
  renderAgentMailCarrier(
    message({ id: "worker-report", subject: "Parser fixed and PR opened, ready for review" }),
  ),
  renderAgentMailCarrier(
    message({
      id: "review-ready",
      from: { ...workflow, resourceId: "review-1" },
      subject: "Multi Review ready: 3 findings",
      body: "Multi Review `review-1` consolidated **3 findings** (1 high, 2 medium).\n\nRead it with `get_multi_review`.",
      notice: {
        resource: { kind: "multi-review", id: "review-1", environmentId: "worker" },
        state: "ready",
        tone: "info",
      },
    }),
  ),
  renderAgentMailCarrier(
    message({
      id: "worker-failed",
      from: { ...workflow, resourceId: "worker" },
      subject: "Worker parser-fix failed",
      body: "Worker environment `worker` failed without sending a report.",
      notice: {
        resource: { kind: "agent-tab", id: "startup-agent", environmentId: "worker" },
        state: "failed",
        tone: "failure",
      },
    }),
  ),
].join("\n\n");

export function MailTilesFixture() {
  const [mounted, setMounted] = useState(true);
  const rows = createPeerMailNativeMessagesFromCarrier({
    content: BATCH,
    createdAt: "2026-10-16T10:04:00.000Z",
  });
  return (
    <div className="@container mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-2 bg-background p-2 text-foreground">
      <button
        type="button"
        className="self-start rounded border px-2 py-1 text-xs"
        onClick={() => setMounted((value) => !value)}
      >
        {mounted ? "Unmount transcript" : "Mount transcript"}
      </button>
      {mounted ? (
        <div data-testid="mail-transcript">
          {rows.map((row) => (
            <NativeMessage key={row.id} message={row} agentExpansionScope="fixture-session" />
          ))}
        </div>
      ) : null}
    </div>
  );
}
