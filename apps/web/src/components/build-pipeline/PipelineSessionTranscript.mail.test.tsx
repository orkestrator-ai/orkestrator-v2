/**
 * What a reader sees of agent mail in a worker's transcript, through the real
 * `NativeMessage` and `MailTile`: the same tile as a native tab, on a running
 * worker and on a finished one read back from the transcript store.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { renderAgentMailCarrier, type AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import type { BuildPipeline, PipelineSession } from "@/stores/buildPipelineStore";
import { PEER_MAIL_UNREADABLE_TEXT } from "@/lib/chat/client-only-messages";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";

const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

/* react-virtuoso measures a real viewport, so its rows never render under happy-dom. */
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  VirtualizedMessageList: ({ messages, renderMessage }: any) => (
    <div>
      {messages.map((message: unknown, index: number) => (
        <div key={index}>{renderMessage(index, message, null)}</div>
      ))}
    </div>
  ),
}));

import {
  graphRunCacheKey,
  graphRunStore,
  type GraphRunTranscriptEntry,
} from "@/stores/graphRunStore";
import type { NodeActivation } from "@orkestrator/protocol/graphs/run";
import { appCommandStore } from "@/test/app-command-store";
const { GraphActivationTranscript } =
  await import("@/components/graph-run/GraphActivationTranscript");
const { PipelineSessionTranscript } = await import("./PipelineSessionTranscript");

afterEach(cleanup);
afterAll(() => {
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

const CARRIER = renderAgentMailCarrier({
  version: 1,
  id: "mail-1",
  threadId: "mail-1",
  requestId: "request-1",
  createdAt: "2026-11-04T03:00:00.000Z",
  from: {
    kind: "node",
    nodeId: "bk_mini",
    nodeName: "mini",
    role: "coordinator",
    projectId: "project-1",
    environmentId: "coordinator:c:v",
    tabId: "coordinator-tab",
    title: null,
  },
  toEnvironmentId: "env-1",
  toTabId: "pipeline-worker:pipeline-1:build:0:key",
  toIncarnationId: "incarnation-1",
  subject: "Scope change",
  body: "Please also cover the parser.",
  bodyBytes: 29,
  trust: "same-project",
  injectDepth: 0,
  threadDepth: 0,
  placement: "injected",
  revision: 1,
} satisfies AgentMailMessage);

function userRow(id: string, content: string) {
  return {
    id,
    role: "user",
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-11-04T03:00:00.000Z",
  };
}

function renderTranscript(
  status: PipelineSession["status"],
  messages: unknown[],
  phase: PipelineSession["phase"] = "build",
  label = "Build Session",
) {
  const session: PipelineSession = {
    phase,
    iteration: 0,
    sessionKey: "pipeline-1:build:0:key",
    sdkSessionId: "build-session",
    status,
    startedAt: "2026-11-04T00:00:00.000Z",
    label,
    messages,
  };
  const pipeline = {
    id: "pipeline-1",
    environmentId: "env-1",
    agentType: "claude",
    phase: status === "running" ? "building" : "complete",
    sessions: [session],
    currentSessionIndex: 0,
  } as unknown as BuildPipeline;
  return renderInAppCommandScope(
    <PipelineSessionTranscript
      pipeline={pipeline}
      session={session}
      visible
      isActive={false}
      ownsGlobalShortcuts={false}
      environmentId="env-1"
      containerId={undefined}
      composer={false}
    />,
  );
}

describe("PipelineSessionTranscript agent mail", () => {
  test.each(["running", "idle"] as const)(
    "draws mail as the mail tile on a %s worker, with no envelope on screen",
    (status) => {
      const { container } = renderTranscript(status, [userRow("row-1", CARRIER)]);

      const tile = container.querySelector<HTMLElement>("[data-mail-tile]");
      expect(tile?.dataset.mailKind).toBe("coordinator");
      expect(tile?.textContent).toContain("Project coordinator on mini");
      expect(tile?.textContent).toContain("Scope change");
      expect(tile?.textContent).toContain("Please also cover the parser.");
      expect(container.textContent).not.toContain("orkestrator-peer");
      expect(container.textContent).not.toContain("messageId");
      expect(container.textContent).not.toContain("You are a build pipeline step");
    },
  );

  test.each(["review", "verify"] as const)("retains mail through the %s filter", (phase) => {
    const { container } = renderTranscript("idle", [userRow("row-1", CARRIER)], phase);
    expect(container.querySelector("[data-mail-tile]")?.textContent).toContain("Scope change");
  });

  test("retains mail in review-package preparation", () => {
    const { container } = renderTranscript(
      "idle",
      [userRow("row-1", CARRIER)],
      "build",
      "Package Preparation Session",
    );
    expect(container.querySelector("[data-mail-tile]")?.textContent).toContain("Scope change");
  });

  test.each([
    '<orkestrator-peer-message version="1">missing payload</orkestrator-peer-message>',
    '<orkestrator-peer-message version="1">\n<orkestrator-peer-payload-json>\n',
  ])("renders damaged framing as a notice (%#)", (content) => {
    const { container } = renderTranscript("idle", [userRow("damaged", content)]);
    expect(container.textContent).toContain(PEER_MAIL_UNREADABLE_TEXT);
    expect(container.textContent).not.toContain("orkestrator-peer");
  });

  test("shows a clean notice for a malformed envelope and keeps the rest of the stage", () => {
    const { container } = renderTranscript("idle", [
      userRow(
        "row-1",
        '<orkestrator-peer-message version="1">\n<orkestrator-peer-payload-json>\n{not json}\n</orkestrator-peer-payload-json>\nInstructions.\n</orkestrator-peer-message>',
      ),
      {
        id: "answer",
        role: "assistant",
        content: "Still working",
        createdAt: "2026-11-04T03:01:00.000Z",
      },
    ]);

    expect(container.querySelector("[data-mail-tile]") === null).toBe(true);
    expect(container.textContent).toContain(PEER_MAIL_UNREADABLE_TEXT);
    expect(container.textContent).toContain("Still working");
    expect(container.textContent).not.toContain("orkestrator-peer");
    expect(container.textContent).not.toContain("not json");
  });

  test("graph activations render stored mail after remount", () => {
    const before = appCommandStore(graphRunStore).getState().transcripts;
    appCommandStore(graphRunStore).setState({
      transcripts: new Map([
        [
          graphRunCacheKey("run", "activation"),
          {
            status: "ready",
            error: null,
            revision: 1,
            view: {
              status: "found",
              messages: [userRow("mail", CARRIER)],
              startIndex: 0,
              messageCount: 1,
              revision: 1,
              complete: true,
            },
          } as GraphRunTranscriptEntry,
        ],
      ]),
    });
    const activation = {
      key: "activation",
      state: "completed",
      session: {
        agent: "codex",
        startedAt: "2026-11-04T00:00:00Z",
        transcript: { manifestRevision: 1, complete: true },
      },
    } as unknown as NodeActivation;
    try {
      for (let mount = 0; mount < 2; mount += 1) {
        const view = renderInAppCommandScope(
          <GraphActivationTranscript
            runId="run"
            environmentId="env-1"
            containerId={undefined}
            activation={activation}
            isActive={false}
            ownsGlobalShortcuts={false}
          />,
        );
        expect(view.container.querySelector("[data-mail-tile]")?.textContent).toContain(
          "Scope change",
        );
        expect(view.container.textContent).not.toContain("orkestrator-peer");
        view.unmount();
      }
    } finally {
      appCommandStore(graphRunStore).setState({ transcripts: before });
    }
  });

  test("renders untrusted fields as text rather than as markup", () => {
    const hostile = CARRIER.replace(
      '"subject":"Scope change"',
      '"subject":"\\u003cimg src=x onerror=alert(1)\\u003e"',
    );
    const { container } = renderTranscript("idle", [userRow("row-1", hostile)]);

    const tile = container.querySelector<HTMLElement>("[data-mail-tile]");
    expect(tile?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(tile?.querySelector("img") === null).toBe(true);
  });

  test("keeps a person's message that names the tag as their own bubble", () => {
    const { container } = renderTranscript("idle", [
      userRow("row-1", "Why does <orkestrator-peer-message> show up here?"),
    ]);

    expect(container.querySelector("[data-mail-tile]") === null).toBe(true);
    expect(container.textContent).toContain("show up here?");
  });
});
