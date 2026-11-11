import { describe, expect, test } from "bun:test";
import {
  usageLimitStopNoticeText,
  type UsageLimitStop,
} from "@orkestrator/protocol/coordinator-notices";
import {
  accountOfToken,
  claudeLastUserText,
  claudeUsage,
  claudeUserTexts,
  fixtureClaudeToken,
  isLimited,
  launchOutcome,
  launchPrompt,
  markerOf,
  noticeFacts,
  piTurn,
  runMarker,
} from "./coordinator-notice-fake-model-script";

function stop(kind: UsageLimitStop["sessionKind"], id: string): UsageLimitStop {
  return {
    id,
    at: "2030-01-01T10:00:00.000Z",
    machine: "Leaf",
    repository: "notice-qa",
    environmentId: `env-${id}`,
    session: `Session ${id}`,
    sessionKind: kind,
    account: { platform: "claude", key: "claude:email:limited-a@example.com" },
    next: "stop",
  };
}

describe("fixture accounts", () => {
  test("a bearer token names its account, and only the limited logins refuse", () => {
    expect(accountOfToken(`Bearer ${fixtureClaudeToken("leaf-a")}`)).toBe("leaf-a");
    expect(accountOfToken("Bearer sk-ant-real")).toBeUndefined();
    expect(accountOfToken(null)).toBeUndefined();
    expect(isLimited("leaf-a")).toBe(true);
    // One login under the command node's own entry is limited too.
    expect(isLimited("desk-b")).toBe(true);
    expect(isLimited("desk-h")).toBe(false);
    expect(isLimited(undefined)).toBe(false);
  });

  test("usage reads below the weekly limit, and the shared login resets before headroom", () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const limited = claudeUsage("desk-b", now) as {
      seven_day: { utilization: number; resets_at: string };
    };
    const headroom = claudeUsage("desk-h", now) as {
      seven_day: { utilization: number; resets_at: string };
    };
    expect(limited.seven_day.utilization).toBeLessThan(100);
    expect(headroom.seven_day.utilization).toBeLessThan(limited.seven_day.utilization);
    expect(Date.parse(limited.seven_day.resets_at)).toBeLessThan(
      Date.parse(headroom.seven_day.resets_at),
    );
    // Once the login has refused, both of its entries read the week used up.
    const refused = new Set(["limited-b@example.com"]);
    for (const account of ["leaf-b", "desk-b"] as const) {
      const reading = claudeUsage(account, now, refused) as { seven_day: { utilization: number } };
      expect(reading.seven_day.utilization).toBe(100);
    }
  });
});

describe("Claude requests", () => {
  test("the run marker is found in any user text, including a tool result", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `Task. ${runMarker("pipeline", "t2-ab")}` }],
        },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        {
          role: "user",
          content: [{ type: "tool_result", content: [{ type: "text", text: "done" }] }],
        },
      ],
    };
    expect(markerOf(claudeUserTexts(body))).toEqual({ kind: "pipeline", run: "t2-ab" });
    expect(claudeLastUserText(body)).toBe("done");
    expect(markerOf(["no marker here"])).toBeNull();
  });

  test("a grouped notice is counted by session kind, never by its text", () => {
    const { body } = usageLimitStopNoticeText({
      stops: [stop("tab", "1"), stop("worker", "2"), stop("pipeline", "3")],
      coordinator: { kind: "unaffected" },
      followUp: false,
    });
    const payload = JSON.stringify({ from: { kind: "system" }, body });
    const prompt = `<orkestrator-peer-payload-json>${payload}</orkestrator-peer-payload-json>`;
    expect(noticeFacts(prompt)).toEqual([
      {
        tab: 1,
        worker: 1,
        pipeline: 1,
        coordinator: 0,
        movedFirst: false,
        kept: false,
        followUp: false,
      },
    ]);
    expect(noticeFacts("Do the fixture task.")).toEqual([]);
  });

  test("a notice after a move says so, and so does one kept without a wake", () => {
    const moved = usageLimitStopNoticeText({
      stops: [stop("tab", "1")],
      coordinator: { kind: "moved", to: "headroom@example.com" },
      followUp: false,
    }).body;
    const kept = usageLimitStopNoticeText({
      stops: [stop("tab", "1")],
      coordinator: { kind: "kept", reason: "no-account-with-headroom" },
      followUp: true,
    }).body;
    expect(noticeFacts(moved)[0]).toMatchObject({ tab: 1, movedFirst: true, kept: false });
    expect(noticeFacts(kept)[0]).toMatchObject({ kept: true, followUp: true, movedFirst: false });
  });
});

describe("the leaf's Pi coordinator", () => {
  const tools = [{ type: "function", function: { name: "orkestrator_launch_environment" } }];
  const input = { projectId: "p1", baseBranch: "main", baseCommit: "abc", agent: "claude" };

  test("a launch prompt calls launch_environment with its input, then answers", () => {
    const first = piTurn({ messages: [{ role: "user", content: launchPrompt(input) }], tools });
    expect(first.step).toEqual({ kind: "tool", name: "orkestrator_launch_environment", input });
    const after = piTurn({
      messages: [
        { role: "user", content: launchPrompt(input) },
        { role: "assistant", content: null },
        { role: "tool", content: "{}" },
      ],
      tools,
    });
    expect(after.step.kind).toBe("text");
    expect(after.launched).toEqual({
      environmentId: false,
      shape: [],
      message: { keys: ["role", "content"], content: "string", excerpt: "{}" },
    });
    const accepted = piTurn({
      messages: [
        { role: "user", content: launchPrompt(input) },
        { role: "assistant", content: null },
        { role: "tool", content: '{"environmentId":"e1","status":"accepted"}' },
      ],
      tools,
    });
    expect(accepted.launched).toEqual({ status: "accepted", environmentId: true });
    // An MCP content envelope carries the tool's JSON escaped inside a string.
    const envelope = JSON.stringify({
      content: [
        { type: "text", text: JSON.stringify({ environmentId: "e1", status: "accepted" }) },
      ],
    });
    expect(launchOutcome(envelope)).toEqual({ status: "accepted", environmentId: true });
    expect(launchOutcome(JSON.stringify({ isError: true }))).toEqual({
      environmentId: false,
      shape: ["isError"],
    });
    expect(launchOutcome("Coordinator launches require an explicit baseBranch")).toEqual({
      environmentId: false,
      error: "Coordinator launches require an explicit baseBranch",
    });
  });

  test("a wake with a usage-limit notice is counted; anything else gets text", () => {
    const { body } = usageLimitStopNoticeText({
      stops: [stop("tab", "1")],
      coordinator: { kind: "unaffected" },
      followUp: false,
    });
    const wake = piTurn({ messages: [{ role: "user", content: body }], tools });
    expect(wake.step.kind).toBe("text");
    expect(wake.notices).toHaveLength(1);
    expect(piTurn({ messages: [{ role: "user", content: "hello" }], tools }).notices).toEqual([]);
    expect(
      piTurn({ messages: [{ role: "user", content: launchPrompt(input) }], tools: [] }).step.kind,
    ).toBe("text");
  });
});
