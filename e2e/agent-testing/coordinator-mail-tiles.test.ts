import { describe, expect, test } from "bun:test";
import { renderAgentMailCarrier, type AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import type { DelegationMailMessage } from "../../apps/desktop/scripts/dev/coordinator-live-delegation";
import { evaluateMailTiles } from "./coordinator-mail-tiles";

function mail(overrides: Partial<AgentMailMessage> = {}): AgentMailMessage {
  return {
    version: 1,
    id: "mail",
    threadId: "mail",
    requestId: "request",
    createdAt: "2026-10-25T10:00:00.000Z",
    from: {
      kind: "tab",
      projectId: "p",
      environmentId: "worker",
      tabId: "startup-agent",
      incarnationId: "i",
      agent: "codex",
      title: "worker",
    },
    toEnvironmentId: "coordinator:c:v",
    toTabId: "coordinator-v",
    toIncarnationId: "i",
    body: "Report",
    bodyBytes: 6,
    trust: "same-project",
    injectDepth: 0,
    threadDepth: 0,
    placement: "injected",
    revision: 1,
    ...overrides,
  };
}

const notice = mail({
  id: "notice-1",
  from: { kind: "system", projectId: "p", source: "workflow", resourceId: "review-1" },
  subject: "Multi Review is ready to address",
  body: "1 finding",
  notice: {
    resource: { kind: "multi-review", id: "review-1", environmentId: "env-1" },
    state: "ready",
    tone: "attention",
  },
});

/** The store's view of a message: what the harness reads from the mailbox. */
function delivered(message: AgentMailMessage): DelegationMailMessage {
  return {
    id: message.id,
    createdAt: message.createdAt,
    from: { kind: message.from.kind },
    toEnvironmentId: message.toEnvironmentId,
    toTabId: message.toTabId,
    placement: "injected",
    ...(message.notice ? { notice: message.notice } : {}),
  };
}

const user = (content: string, parts: unknown[] = []) => ({ role: "user", content, parts });

describe("live coordinator mail tiles", () => {
  test("single and batched echoes become one toned tile per message", () => {
    const one = mail({ id: "mail-1" });
    const two = mail({ id: "mail-2" });
    const { checks, observed } = evaluateMailTiles({
      messages: [
        user("Start the scenario"),
        user(renderAgentMailCarrier(one)),
        { role: "assistant", content: "ok" },
        user(`${renderAgentMailCarrier(two)}\n\n${renderAgentMailCarrier(notice)}`),
      ],
      delivered: [one, two, notice].map(delivered),
      requireBatched: true,
    });
    expect(checks.filter((item) => !item.passed)).toEqual([]);
    expect(observed).toEqual({ carrierRows: 2, tileRows: 2, batchedRows: 1, tiles: 3 });
  });

  test("an echo the renderer would show raw fails, whatever else it holds", () => {
    const one = mail({ id: "mail-1" });
    // A provider that prefixes the echo, or keeps the carrier only in a part.
    const { checks } = evaluateMailTiles({
      messages: [
        user(`Message received:\n${renderAgentMailCarrier(one)}`),
        user("", [{ type: "text", content: renderAgentMailCarrier(mail({ id: "mail-2" })) }]),
      ],
      delivered: [one, mail({ id: "mail-2" })].map(delivered),
    });
    const failed = checks.filter((item) => !item.passed).map((item) => item.name);
    expect(failed).toEqual(["mail-tiles-no-raw-carrier", "mail-tiles-one-per-message"]);
    expect(checks[0]!.detail).toBe("rows shown as raw carrier text: 0, 1");
  });

  test("a dropped carrier, a missing message, a repeat and trailing text each fail", () => {
    const one = mail({ id: "mail-1" });
    const broken = renderAgentMailCarrier(mail({ id: "mail-2" })).replace(
      "<orkestrator-peer-payload-json>",
      "<orkestrator-peer-payload-json>{",
    );
    const { checks } = evaluateMailTiles({
      messages: [
        user(`${renderAgentMailCarrier(one)}\n${broken}`),
        user(`${renderAgentMailCarrier(one)}\nanswer briefly`),
      ],
      delivered: [one, mail({ id: "mail-3" })].map(delivered),
      requireBatched: true,
      prefix: "peer-tiles",
    });
    const byName = Object.fromEntries(checks.map((item) => [item.name, item]));
    expect(byName["peer-tiles-no-raw-carrier"]!.passed).toBe(true);
    expect(byName["peer-tiles-one-per-message"]).toMatchObject({
      passed: false,
      detail:
        "2 delivered, 2 tiles in 2 rows; 1 without a tile, 1 shown twice, carriers dropped in rows 0",
    });
    expect(byName["peer-tiles-nothing-outside-carriers"]).toMatchObject({
      passed: false,
      detail: "text outside the carriers in rows 1",
    });
    expect(byName["peer-tiles-batched"]).toMatchObject({ passed: false });
  });

  test("a notice tile must carry its notice's tone", () => {
    const { checks } = evaluateMailTiles({
      messages: [user(renderAgentMailCarrier(notice))],
      delivered: [{ ...delivered(notice), notice: { ...notice.notice!, tone: "success" } }],
    });
    expect(checks.find((item) => item.name === "mail-tiles-notice-tone")).toMatchObject({
      passed: false,
      detail: "tiles toned attention for success",
    });
  });
});
