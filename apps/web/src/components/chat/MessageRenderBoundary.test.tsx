import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  MessageRenderBoundary,
  messageRenderResetKey,
} from "./MessageRenderBoundary";
import type {
  NativeMessage,
  NativeMessagePart,
} from "@/lib/chat/native-message-types";

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("message renderer exploded");
  return <div>rendered fine</div>;
}

function message(parts: NativeMessagePart[], content = ""): NativeMessage {
  return {
    id: "m1",
    role: "assistant",
    content,
    parts,
    createdAt: "2026-08-17T00:00:00.000Z",
  };
}

afterEach(cleanup);

describe("MessageRenderBoundary", () => {
  test("contains a throwing row to its own fallback", () => {
    const { container } = render(
      <div>
        <MessageRenderBoundary resetKey="a">
          <div>first message</div>
        </MessageRenderBoundary>
        <MessageRenderBoundary resetKey="b">
          <Bomb shouldThrow />
        </MessageRenderBoundary>
        <MessageRenderBoundary resetKey="c">
          <div>third message</div>
        </MessageRenderBoundary>
      </div>,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("first message");
    expect(text).toContain("third message");
    expect(text).toContain("One message could not be displayed");
    expect(text).not.toContain("rendered fine");
  });

  test("retries when the reset key changes", () => {
    const { container, rerender } = render(
      <MessageRenderBoundary resetKey="m1|1">
        <Bomb shouldThrow />
      </MessageRenderBoundary>,
    );
    expect(container.textContent).toContain("One message could not be displayed");

    // A later poll reports newer content for this message; the row must retry.
    rerender(
      <MessageRenderBoundary resetKey="m1|2">
        <Bomb shouldThrow={false} />
      </MessageRenderBoundary>,
    );
    expect(container.textContent).toBe("rendered fine");
  });

  test("stays failed while the same message re-renders", () => {
    const { container, rerender } = render(
      <MessageRenderBoundary resetKey="m1|1">
        <Bomb shouldThrow />
      </MessageRenderBoundary>,
    );
    rerender(
      <MessageRenderBoundary resetKey="m1|1">
        <Bomb shouldThrow />
      </MessageRenderBoundary>,
    );
    expect(container.textContent).toContain("One message could not be displayed");
  });

  test("does not retry a failed row when a poll rebuilds an unchanged message", () => {
    // The regression this guards: a read-only transcript re-derives every
    // message object on every refresh, so an identity-keyed boundary retried a
    // deterministically failing row every interval for the life of the review —
    // re-throwing and re-logging each time instead of staying contained.
    let renderAttempts = 0;
    const Counting = () => {
      renderAttempts += 1;
      throw new Error("message renderer exploded");
    };
    const parts: NativeMessagePart[] = [
      { type: "text", content: "Reviewing the diff." },
    ];

    const { container, rerender } = render(
      <MessageRenderBoundary resetKey={messageRenderResetKey(message(parts))}>
        <Counting />
      </MessageRenderBoundary>,
    );
    expect(container.textContent).toContain("One message could not be displayed");
    const attemptsAfterFirstFailure = renderAttempts;
    // Guards against the assertion below passing vacuously.
    expect(attemptsAfterFirstFailure).toBeGreaterThan(0);

    for (let poll = 0; poll < 3; poll += 1) {
      // A fresh object graph with byte-identical content, as each poll produces.
      rerender(
        <MessageRenderBoundary
          resetKey={messageRenderResetKey(
            message([{ type: "text", content: "Reviewing the diff." }]),
          )}
        >
          <Counting />
        </MessageRenderBoundary>,
      );
    }

    expect(renderAttempts).toBe(attemptsAfterFirstFailure);
    expect(container.textContent).toContain("One message could not be displayed");
  });
});

describe("messageRenderResetKey", () => {
  test("is stable across rebuilt objects with equal content", () => {
    const parts: NativeMessagePart[] = [
      { type: "text", content: "Inspecting the changed files" },
      { type: "tool-invocation", content: "git diff", toolState: "pending" },
    ];
    expect(messageRenderResetKey(message(parts, "tail"))).toBe(
      messageRenderResetKey(message([
        { type: "text", content: "Inspecting the changed files" },
        { type: "tool-invocation", content: "git diff", toolState: "pending" },
      ], "tail")),
    );
  });

  test("changes when a streaming part grows", () => {
    const before = messageRenderResetKey(message([
      { type: "text", content: "Inspecting" },
    ]));
    const after = messageRenderResetKey(message([
      { type: "text", content: "Inspecting the" },
    ]));
    expect(after).not.toBe(before);
  });

  test("changes when a tool row settles without changing its text", () => {
    const pending = messageRenderResetKey(message([
      { type: "tool-invocation", content: "git diff", toolState: "pending" },
    ]));
    const settled = messageRenderResetKey(message([
      { type: "tool-invocation", content: "git diff", toolState: "failure" },
    ]));
    expect(settled).not.toBe(pending);
  });

  test("sees growth nested inside a group part", () => {
    const group = (childContent: string): NativeMessagePart => ({
      type: "tool-group",
      content: "",
      parts: [{ type: "tool-invocation", content: childContent }],
    });
    expect(messageRenderResetKey(message([group("rg foo")])))
      .not.toBe(messageRenderResetKey(message([group("rg foobar")])));
  });

  test("sees growth nested inside a task group's children", () => {
    const task = (childCount: number): NativeMessagePart => ({
      type: "task-group",
      content: "",
      task: { type: "tool-invocation", content: "Task" },
      childTools: Array.from({ length: childCount }, (_unused, index) => ({
        type: "tool-invocation" as const,
        content: `step ${index}`,
      })),
    });
    expect(messageRenderResetKey(message([task(1)])))
      .not.toBe(messageRenderResetKey(message([task(2)])));
  });

  test("sees a subagent row's actions stream in", () => {
    const subagent = (actionCount: number): NativeMessagePart => ({
      type: "subagent",
      content: "Explore",
      subagentActions: Array.from({ length: actionCount }, () => ({
        type: "tool-invocation" as const,
        content: "rg",
      })),
    });
    expect(messageRenderResetKey(message([subagent(1)])))
      .not.toBe(messageRenderResetKey(message([subagent(2)])));
  });

  test("terminates on a self-referential part instead of recursing forever", () => {
    // Not a shape the projection produces; the depth cap exists so a malformed
    // one degrades to a truncated key rather than hanging a render.
    const cyclic = {
      type: "tool-group",
      content: "",
      parts: [] as NativeMessagePart[],
    } as NativeMessagePart & { parts: NativeMessagePart[] };
    cyclic.parts.push(cyclic);
    expect(typeof messageRenderResetKey(message([cyclic]))).toBe("string");
  });
});
