/**
 * Agent mail in a stored worker transcript. The row a provider stored is the
 * delivery envelope itself, so these start from `renderAgentMailCarrier`, what
 * the backend really sends, rather than from a hand-written copy of its format.
 */
import { describe, expect, test } from "bun:test";
import {
  renderAgentMailCarrier,
  type AgentMailMessage,
  type MailActor,
} from "@orkestrator/protocol/agent-mail";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { getNativeMessageSearchText } from "@/components/chat/native-message-search";
import { toMultiReviewSessionMessages } from "@/components/review/MultiReviewReviewerTab";
import {
  PEER_MAIL_UNREADABLE_TEXT,
  STRUCTURED_PROMPT_SUFFIX_PREFIX,
} from "@/lib/chat/client-only-messages";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { STRUCTURED_PROMPT_INSTRUCTION_PREFIX } from "../../../../../bridges/acp-bridge/src/structured-prompt-marker";
import { toPipelineTranscript } from "./pipeline-transcript";

const FALLBACK = "2026-11-04T00:00:00.000Z";
const DELIVERED_AT = "2026-11-04T03:00:00.000Z";

const COORDINATOR: MailActor = {
  kind: "coordinator",
  projectId: "project-1",
  coordinatorId: "coordinator-1",
  conversationId: "conversation-1",
  environmentId: "coordinator:coordinator-1:conversation-1",
  tabId: "coordinator-tab",
  incarnationId: "incarnation-1",
  agent: "claude",
  title: "Release coordinator",
};

function mail(overrides: Partial<AgentMailMessage> = {}): AgentMailMessage {
  return {
    version: 1,
    id: "mail-1",
    threadId: "mail-1",
    requestId: "request-1",
    createdAt: DELIVERED_AT,
    from: COORDINATOR,
    toEnvironmentId: "env-1",
    toTabId: pipelineWorkerTabId("pipeline-1:build:0:key"),
    toIncarnationId: "incarnation-2",
    subject: "Scope change",
    body: "Please also cover the **parser**.",
    bodyBytes: 33,
    trust: "same-project",
    injectDepth: 0,
    threadDepth: 0,
    placement: "injected",
    revision: 1,
    ...overrides,
  };
}

function userRow(id: string, content: string) {
  return {
    id,
    role: "user",
    content,
    parts: [{ type: "text", content }],
    createdAt: DELIVERED_AT,
  };
}

/** Everything a reader or a transcript search could reach of a row. */
function visibleText(row: NativeMessage): string {
  const { sender, subject, warning, body } = row.peerMail ?? {};
  return JSON.stringify([
    row.content,
    row.parts,
    sender,
    subject,
    warning,
    body,
    getNativeMessageSearchText(row),
  ]);
}

function expectNoEnvelope(rows: readonly NativeMessage[]) {
  for (const row of rows) {
    expect(visibleText(row)).not.toContain("orkestrator-peer");
    expect(visibleText(row)).not.toContain('"from"');
    expect(visibleText(row)).not.toContain("\\u003c");
  }
}

describe("toPipelineTranscript with agent mail", () => {
  test.each([...AGENT_PLATFORMS])("draws delivered mail as a tile on %s", (agent) => {
    const rows = toPipelineTranscript(
      [userRow("row-1", renderAgentMailCarrier(mail()))],
      agent,
      FALLBACK,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "peer-mail-mail-1",
      role: "system",
      createdAt: DELIVERED_AT,
      peerMail: {
        messageId: "mail-1",
        kind: "coordinator",
        sender: "Release coordinator",
        subject: "Scope change",
        body: "Please also cover the **parser**.",
      },
    });
    expectNoEnvelope(rows);
  });

  test("gives each message of a batched delivery its own tile, in order", () => {
    const batched = [
      renderAgentMailCarrier(mail({ id: "mail-a", subject: "First" })),
      renderAgentMailCarrier(mail({ id: "mail-b", subject: "Second" })),
    ].join("\n\n");

    const rows = toPipelineTranscript([userRow("row-1", batched)], "codex", FALLBACK);

    expect(rows.map((row) => row.peerMail?.subject)).toEqual(["First", "Second"]);
    expectNoEnvelope(rows);
  });

  test("reads the same from a stored transcript as live, so a reload changes nothing", () => {
    // A finished worker's rows come back through JSON from the transcript store.
    const live = [
      { id: "prompt", role: "user", content: "Build it", createdAt: FALLBACK },
      userRow("row-1", renderAgentMailCarrier(mail())),
      { id: "answer", role: "assistant", content: "Done", createdAt: DELIVERED_AT },
    ];
    const stored = JSON.parse(JSON.stringify(live)) as unknown[];

    const first = toPipelineTranscript(live, "claude", FALLBACK);
    const reloaded = toPipelineTranscript(stored, "claude", FALLBACK);

    expect(reloaded).toEqual(first);
    // Keyed on the mail, so the row and its open or closed state stay put.
    expect(reloaded[1]!.id).toBe("peer-mail-mail-1");
    expect(reloaded.map((row) => row.role)).toEqual(["user", "system", "assistant"]);
  });

  test("draws mail steered into a running turn where it landed, between its replies", () => {
    const steered = renderAgentMailCarrier(
      mail({ injectedVia: "steer", injectedAt: DELIVERED_AT }),
    );
    for (const agent of ["claude", "codex"] as const) {
      const rows = toPipelineTranscript(
        [
          { id: "before", role: "assistant", content: "Working", createdAt: FALLBACK },
          userRow("steer", steered),
          { id: "after", role: "assistant", content: "Noted", createdAt: DELIVERED_AT },
        ],
        agent,
        FALLBACK,
      );

      expect(rows.map((row) => row.id)).toEqual(["before", "peer-mail-mail-1", "after"]);
      expectNoEnvelope(rows);
    }
  });

  test("draws mail delivered as its own turn after the worker went idle", () => {
    const rows = toPipelineTranscript(
      [
        { id: "first-answer", role: "assistant", content: "Finished", createdAt: FALLBACK },
        userRow("mail-turn", renderAgentMailCarrier(mail())),
        { id: "second-answer", role: "assistant", content: "Covered", createdAt: DELIVERED_AT },
      ],
      "codex",
      FALLBACK,
    );

    expect(rows.map((row) => row.id)).toEqual([
      "first-answer",
      "peer-mail-mail-1",
      "second-answer",
    ]);
  });

  test("recognises an envelope stored in a text part with an empty content", () => {
    const carrier = renderAgentMailCarrier(mail());
    const rows = toPipelineTranscript(
      [{ id: "row-1", role: "user", content: "", parts: [{ type: "text", content: carrier }] }],
      "codex",
      FALLBACK,
    );

    expect(rows.map((row) => row.id)).toEqual(["peer-mail-mail-1"]);
  });

  test("leaves the backend's own instructions frame out of the tile", () => {
    const framed = `${renderAgentMailCarrier(mail())}\n\n<orkestrator-system-instructions>\nProvider-only guidance\n</orkestrator-system-instructions>`;
    const rows = toPipelineTranscript([userRow("row-1", framed)], "claude", FALLBACK);

    expect(rows.map((row) => row.id)).toEqual(["peer-mail-mail-1"]);
    expect(visibleText(rows[0]!)).not.toContain("Provider-only guidance");
  });

  test.each(["cursor", "pi", "grok"] as const)(
    "leaves the schema instruction a bridge stores after the carrier out on %s",
    (agent) => {
      const schema = `${STRUCTURED_PROMPT_INSTRUCTION_PREFIX} matching this JSON Schema.\n\n{"type":"object"}`;
      const rows = toPipelineTranscript(
        [userRow("row-1", `${renderAgentMailCarrier(mail())}\n\n${schema}`)],
        agent,
        FALLBACK,
      );

      expect(rows.map((row) => row.id)).toEqual(["peer-mail-mail-1"]);
      expect(visibleText(rows[0]!)).not.toContain("JSON Schema");
    },
  );

  test("names the schema instruction with the bridges' own words", () => {
    expect(STRUCTURED_PROMPT_SUFFIX_PREFIX).toBe(STRUCTURED_PROMPT_INSTRUCTION_PREFIX);
  });

  test("shows one tile for a delivery repeated within or across rows", () => {
    const carrier = renderAgentMailCarrier(mail());
    const rows = toPipelineTranscript(
      [userRow("row-1", `${carrier}\n\n${carrier}`), userRow("row-2", carrier)],
      "codex",
      FALLBACK,
    );

    expect(rows.map((row) => row.id)).toEqual(["peer-mail-mail-1"]);
  });

  test("names a coordinator on another node by that node", () => {
    const [row] = toPipelineTranscript(
      [
        userRow(
          "row-1",
          renderAgentMailCarrier(
            mail({
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
            }),
          ),
        ),
      ],
      "claude",
      FALLBACK,
    );

    expect(row!.peerMail).toMatchObject({
      kind: "coordinator",
      sender: "Project coordinator on mini",
    });
    expectNoEnvelope([row!]);
  });

  test("names an agent on another node by its environment, tab and node", () => {
    const [row] = toPipelineTranscript(
      [
        userRow(
          "row-1",
          renderAgentMailCarrier(
            mail({
              from: {
                kind: "node",
                nodeId: "bk_mini",
                nodeName: "mini",
                role: "agent",
                projectId: "project-1",
                environmentId: "env-remote",
                tabId: "startup-agent",
                title: "Claude 2",
                environmentName: "fix-login-bug",
              },
            }),
          ),
        ),
      ],
      "claude",
      FALLBACK,
    );

    expect(row!.peerMail).toMatchObject({
      kind: "message",
      sender: "fix-login-bug · Claude 2 on mini",
      address: { node: "mini", environmentName: "fix-login-bug", tabName: "Claude 2" },
    });
  });

  test("keeps markup in a message body as the sender's text, not as an envelope", () => {
    const body = 'See <orkestrator-peer-message version="1"> and </orkestrator-peer-message> here.';
    const [row, ...rest] = toPipelineTranscript(
      [userRow("row-1", renderAgentMailCarrier(mail({ body })))],
      "codex",
      FALLBACK,
    );

    expect(rest).toEqual([]);
    expect(row!.peerMail?.body).toBe(body);
  });

  test("does not change the stored rows it reads", () => {
    const carrier = renderAgentMailCarrier(mail());
    const stored = [userRow("row-1", carrier)];
    const before = JSON.stringify(stored);

    toPipelineTranscript(stored, "claude", FALLBACK);

    expect(JSON.stringify(stored)).toBe(before);
    expect(stored[0]!.content).toBe(carrier);
    expect(stored[0]!.content).toStartWith('<orkestrator-peer-message version="1">');
  });
});

describe("toPipelineTranscript with an envelope it cannot read", () => {
  const frame = (payload: string, open = '<orkestrator-peer-message version="1">') =>
    `${open}\n<orkestrator-peer-payload-json>\n${payload}\n</orkestrator-peer-payload-json>\nInstructions for the agent.\n</orkestrator-peer-message>`;
  const validPayload = {
    messageId: "mail-bad",
    trust: "same-project",
    body: "Secret-looking body",
    from: COORDINATOR,
  };

  test.each([
    ["payload that is not JSON", frame("{not json")],
    ["payload that is not an object", frame("[1, 2]")],
    ["frame with no JSON at all", frame("nothing readable")],
    [
      "unknown version",
      frame(JSON.stringify(validPayload), '<orkestrator-peer-message version="2">'),
    ],
    ["envelope cut off mid-payload", `${frame(JSON.stringify(validPayload)).slice(0, 120)}`],
    ["unknown trust", frame(JSON.stringify({ ...validPayload, trust: "total" }))],
    ["no sender", frame(JSON.stringify({ ...validPayload, from: undefined }))],
    ["unknown sender kind", frame(JSON.stringify({ ...validPayload, from: { kind: "cluster" } }))],
    [
      "mistyped sender name",
      frame(JSON.stringify({ ...validPayload, from: { ...COORDINATOR, title: 7 } })),
    ],
    [
      "recipient the mailbox helpers refuse",
      frame(JSON.stringify({ ...validPayload, to: { environmentId: "", tabId: "" } })),
    ],
    [
      "sender address the mailbox helpers refuse",
      frame(
        JSON.stringify({
          ...validPayload,
          from: { ...COORDINATOR, tabId: "a\0b" },
          to: { environmentId: "env-1", tabId: "tab" },
        }),
      ),
    ],
  ])("renders a clean notice for %s", (_name, content) => {
    const rows = toPipelineTranscript(
      [
        { id: "before", role: "assistant", content: "Working", createdAt: FALLBACK },
        userRow("row-1", content),
        { id: "after", role: "assistant", content: "Continuing", createdAt: DELIVERED_AT },
      ],
      "codex",
      FALLBACK,
    );

    expect(rows.map((row) => row.id)).toEqual([
      "before",
      "system-peer-mail-unreadable:row-1:0",
      "after",
    ]);
    expect(rows[1]).toMatchObject({ role: "system", content: PEER_MAIL_UNREADABLE_TEXT });
    expect(rows[1]!.peerMail).toBeUndefined();
    expectNoEnvelope([rows[1]!]);
    expect(visibleText(rows[1]!)).not.toContain("Instructions for the agent");
    expect(visibleText(rows[1]!)).not.toContain("Secret-looking body");
  });

  test("keeps the readable messages of a batch around an unreadable one, in order", () => {
    const batched = [
      renderAgentMailCarrier(mail({ id: "mail-a" })),
      frame("{not json"),
      renderAgentMailCarrier(mail({ id: "mail-b" })),
    ].join("\n\n");

    const rows = toPipelineTranscript([userRow("row-1", batched)], "claude", FALLBACK);

    expect(rows.map((row) => row.id)).toEqual([
      "peer-mail-mail-a",
      "system-peer-mail-unreadable:row-1:1",
      "peer-mail-mail-b",
    ]);
    expectNoEnvelope(rows);
  });
});

describe("toPipelineTranscript with a message that only mentions the envelope", () => {
  const carrier = renderAgentMailCarrier(mail());

  test.each([
    ["names the tag mid-sentence", "Why does <orkestrator-peer-message> show up in the bubble?"],
    ["starts with the open tag", '<orkestrator-peer-message version="1"> is what I see. Why?'],
    [
      "starts with both open tags",
      '<orkestrator-peer-message version="1"><orkestrator-peer-payload-json> what is this?',
    ],
    ["quotes an envelope after a question", `What is this?\n\n${carrier}`],
    ["names only the payload tag", "<orkestrator-peer-payload-json>"],
  ])("keeps a person's message that %s as written", (_name, content) => {
    for (const agent of ["claude", "codex"] as const) {
      const rows = toPipelineTranscript([userRow("row-1", content)], agent, FALLBACK);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "row-1", role: "user", content });
      expect(rows[0]!.peerMail).toBeUndefined();
    }
  });

  test("keeps the question of a person who pasted an envelope, without showing the markup", () => {
    const rows = toPipelineTranscript(
      [userRow("row-1", `${carrier}\n\nWhat is this?`)],
      "codex",
      FALLBACK,
    );

    expect(rows.map((row) => [row.id, row.role])).toEqual([
      ["peer-mail-mail-1", "system"],
      ["row-1", "user"],
    ]);
    expect(rows[1]!.content).toBe("What is this?");
    expectNoEnvelope(rows);
  });

  test("never reads an agent's own text as mail", () => {
    const rows = toPipelineTranscript(
      [{ id: "row-1", role: "assistant", content: carrier, createdAt: FALLBACK }],
      "codex",
      FALLBACK,
    );

    expect(rows.map((row) => [row.id, row.role])).toEqual([["row-1", "assistant"]]);
  });
});

describe("transcript search over agent mail", () => {
  test("finds the body and none of the markup", () => {
    const [row] = toPipelineTranscript(
      [userRow("row-1", renderAgentMailCarrier(mail()))],
      "codex",
      FALLBACK,
    );
    const text = getNativeMessageSearchText(row!);

    expect(text).toContain("Please also cover the parser.");
    expect(text).not.toContain("orkestrator-peer");
    expect(text).not.toContain("payload");
    expect(text).not.toContain("trust");
  });

  test("finds a notice's own words, never the envelope's", () => {
    const [row] = toPipelineTranscript(
      [
        userRow(
          "row-1",
          '<orkestrator-peer-message version="1">\n<orkestrator-peer-payload-json>\n{not json}\n</orkestrator-peer-payload-json>\n</orkestrator-peer-message>',
        ),
      ],
      "codex",
      FALLBACK,
    );

    expect(getNativeMessageSearchText(row!)).toBe(PEER_MAIL_UNREADABLE_TEXT);
  });
});

describe("other stored-transcript views that share this projection", () => {
  test("a Multi Review session shows mail while hiding the workflow's own prompts", () => {
    const rows = toMultiReviewSessionMessages(
      [
        { id: "prompt", role: "user", content: "Review this", createdAt: FALLBACK },
        userRow("row-1", renderAgentMailCarrier(mail())),
        { id: "answer", role: "assistant", content: "Reviewing", createdAt: DELIVERED_AT },
      ],
      "codex",
      FALLBACK,
    );

    expect(rows.map((row) => row.id)).toEqual(["peer-mail-mail-1", "answer"]);
    expectNoEnvelope(rows);
  });
});
