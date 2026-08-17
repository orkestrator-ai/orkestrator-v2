import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MessageRenderBoundary } from "./MessageRenderBoundary";

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("message renderer exploded");
  return <div>rendered fine</div>;
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

  test("retries when the message identity changes", () => {
    const first = { id: "m1" };
    const { container, rerender } = render(
      <MessageRenderBoundary resetKey={first}>
        <Bomb shouldThrow />
      </MessageRenderBoundary>,
    );
    expect(container.textContent).toContain("One message could not be displayed");

    // A later poll replaces the message object; the row must retry.
    const second = { id: "m1" };
    rerender(
      <MessageRenderBoundary resetKey={second}>
        <Bomb shouldThrow={false} />
      </MessageRenderBoundary>,
    );
    expect(container.textContent).toBe("rendered fine");
  });

  test("stays failed while the same message re-renders", () => {
    const message = { id: "m1" };
    const { container, rerender } = render(
      <MessageRenderBoundary resetKey={message}>
        <Bomb shouldThrow />
      </MessageRenderBoundary>,
    );
    rerender(
      <MessageRenderBoundary resetKey={message}>
        <Bomb shouldThrow />
      </MessageRenderBoundary>,
    );
    expect(container.textContent).toContain("One message could not be displayed");
  });
});
