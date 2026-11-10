import { describe, expect, test } from "bun:test";
import {
  FAKE_REPLY,
  HOLD_MARKER,
  MAIL_BODY,
  MAIL_TOOL,
  findLogEntries,
  mailMarker,
  parseMailInstruction,
  scriptedStep,
  parseShimInvocations,
  shellQuote,
  shouldHold,
  slowSshShimScript,
} from "./coordinator-slow-remote-support";

describe("coordinator slow-remote support", () => {
  test("the shim serves only its own repository and records no arguments", () => {
    const script = slowSshShimScript({
      bareRepository: "/scratch/it's/origin.git",
      invocations: "/scratch/count",
      delayMarker: "/scratch/delay",
      delaySeconds: 15,
    });
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`exec git-upload-pack ${shellQuote("/scratch/it's/origin.git")}`);
    expect(script).toContain("if [ -e '/scratch/delay' ]; then sleep 15; fi");
    // Only a timestamp is recorded: never "$@", "$1" or the remote command.
    expect(script).not.toMatch(/\$@|\$\*|\$1|\$2|SSH_ORIGINAL_COMMAND/);
    expect(() =>
      slowSshShimScript({
        bareRepository: "/r",
        invocations: "/c",
        delayMarker: "/d",
        delaySeconds: 0,
      }),
    ).toThrow();
  });

  test("shellQuote survives a single quote", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  test("invocations are millisecond timestamps, one per line", () => {
    expect(parseShimInvocations("1762740000000\n\nnot-a-time\n1762740001234\n")).toEqual([
      1762740000000, 1762740001234,
    ]);
  });

  test("log entries are read from text and JSON lines", () => {
    const text = [
      "[coordinator] checkout.message-check projectId=p1 outcome=fast-forwarded fetch=timed-out durationMs=3012",
      "[coordinator] checkout.message-check-failed projectId=p1",
      '{"orklog":1,"area":"coordinator","event":"checkout.mail-follow","fields":{"projectId":"p2","outcome":"fast-forwarded-fetched"}}',
      '[other] checkout.mail-follow projectId=p3 outcome=x note="a b"',
      '[coordinator] checkout.mail-follow projectId=p4 outcome=timed-out note="quoted \\"value\\""',
    ].join("\n");
    expect(findLogEntries(text, "coordinator", "checkout.message-check")).toEqual([
      {
        area: "coordinator",
        event: "checkout.message-check",
        fields: {
          projectId: "p1",
          outcome: "fast-forwarded",
          fetch: "timed-out",
          durationMs: "3012",
        },
      },
    ]);
    expect(
      findLogEntries(text, "coordinator", "checkout.mail-follow").map((entry) => entry.fields),
    ).toEqual([
      { projectId: "p2", outcome: "fast-forwarded-fetched" },
      { projectId: "p4", outcome: "timed-out", note: 'quoted "value"' },
    ]);
  });

  test("only a latest user message with the marker is held", () => {
    const user = (content: unknown) => ({ role: "user", content });
    expect(shouldHold([user(`Read the README. ${HOLD_MARKER}`)])).toBe(true);
    expect(shouldHold([user([{ type: "text", text: `x ${HOLD_MARKER}` }])])).toBe(true);
    expect(
      shouldHold([
        user(`first ${HOLD_MARKER}`),
        { role: "assistant", content: "Noted." },
        user("mail arrived"),
      ]),
    ).toBe(false);
    expect(shouldHold([user(HOLD_MARKER), { role: "assistant", content: "Noted." }])).toBe(true);
    expect(shouldHold(undefined)).toBe(false);
    expect(shouldHold([])).toBe(false);
  });

  test("a worker prompt with a mail marker sends that mail once, then replies", () => {
    const instruction = {
      toEnvironmentId: "coordinator:c1:conv-1",
      toTabId: "coordinator-conv-1",
      fromTabId: "slow-remote-worker",
    };
    const marker = mailMarker(instruction);
    expect(parseMailInstruction(`Report. ${marker}`)).toEqual(instruction);
    expect(() => mailMarker({ ...instruction, toTabId: "a b" })).toThrow();
    const prompt = { role: "user", content: `Report to the coordinator. ${marker}` };
    const tools = [{ type: "function", function: { name: MAIL_TOOL } }];
    expect(scriptedStep({ messages: [prompt], tools })).toEqual({
      kind: "tool",
      name: MAIL_TOOL,
      input: {
        requestId: "slow-remote-slow-remote-worker",
        fromTabId: "slow-remote-worker",
        toEnvironmentId: "coordinator:c1:conv-1",
        toTabId: "coordinator-conv-1",
        body: MAIL_BODY,
      },
    });
    // After the tool result, and without the tool on offer, it only replies.
    expect(
      scriptedStep({
        messages: [prompt, { role: "assistant" }, { role: "tool", content: "sent" }],
        tools,
      }),
    ).toEqual({ kind: "text", text: FAKE_REPLY });
    expect(scriptedStep({ messages: [prompt], tools: [] })).toEqual({
      kind: "text",
      text: FAKE_REPLY,
    });
    expect(scriptedStep({ messages: [{ role: "user", content: "What changed?" }], tools })).toEqual(
      { kind: "text", text: FAKE_REPLY },
    );
  });
});
