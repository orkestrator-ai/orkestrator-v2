import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { NativeMessage } from "./NativeMessage";

function message(part: NativeMessagePart) {
  return {
    id: "mail-tools",
    role: "assistant" as const,
    content: "",
    createdAt: new Date(0).toISOString(),
    parts: [part],
  };
}
afterEach(cleanup);

describe("native renderer mail tool routing", () => {
  test.each(["send_message", "reply_message"])("renders %s as a sent tile", (toolName) => {
    const { container } = render(
      <NativeMessage
        message={message({
          type: "tool-invocation",
          content: toolName,
          toolName,
          toolState: "success",
          toolArgs: {
            toEnvironmentId: "coordinator",
            messageId: "reply-target",
            body: "Here is the result",
            subject: "Report",
          },
        })}
      />,
    );
    expect(container.querySelector("[data-mail-tone=sent]")).toBeTruthy();
    expect(screen.getByText("Here is the result")).toBeTruthy();
    expect(screen.getByText("Report")).toBeTruthy();
  });
  test("read_message eagerly loads deferred results without expanding a row", async () => {
    const loadToolDetails = mock(async (detailRef: string) => ({
      detailRef,
      toolOutput: JSON.stringify({
        message: {
          id: "read",
          from: { kind: "external" },
          trust: "external",
          body: "External request",
          toEnvironmentId: "recipient",
          toTabId: "agent",
        },
      }),
    }));
    const { container } = render(
      <NativeMessage
        message={message({
          type: "tool-invocation",
          content: "read",
          toolName: "read_message",
          toolState: "success",
          toolArgs: { messageId: "read" },
          detailRef: "mail-read-eager",
        })}
        loadToolDetails={loadToolDetails}
      />,
    );
    expect(await screen.findByText("External request")).toBeTruthy();
    expect(loadToolDetails).toHaveBeenCalledWith("mail-read-eager");
    expect(container.querySelector("[data-mail-kind=external]")).toBeTruthy();
    expect(screen.getByText("read")).toBeTruthy();
  });
  test("a deferred toolError replaces the loading mail tile with the failed tool row", async () => {
    const loadToolDetails = mock(async (detailRef: string) => ({
      detailRef,
      toolError: "Message no longer exists",
    }));
    const { container } = render(
      <NativeMessage
        message={message({
          type: "tool-invocation",
          content: "read",
          toolName: "read_message",
          toolState: "success",
          toolArgs: { messageId: "missing" },
          detailRef: "mail-read-error",
        })}
        loadToolDetails={loadToolDetails}
      />,
    );
    await waitFor(() => expect(loadToolDetails).toHaveBeenCalledWith("mail-read-error"));
    const row = await screen.findByRole("button", { name: /Read Message/i });
    expect(container.querySelector("[data-mail-tile]") === null).toBe(true);
    fireEvent.click(row);
    expect(await screen.findByText("Message no longer exists")).toBeTruthy();
  });
});
