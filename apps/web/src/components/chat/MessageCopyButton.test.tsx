import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessageCopyButton } from "./MessageCopyButton";
import { mockWriteText } from "../../../../../tests/mocks/clipboard";

const toastErrorMock = mock(() => {});

mock.module("sonner", () => ({
  toast: {
    error: toastErrorMock,
  },
}));

describe("MessageCopyButton", () => {
  afterEach(() => {
    cleanup();
    toastErrorMock.mockClear();
    mockWriteText.mockReset();
    mockWriteText.mockImplementation(async () => {});
  });

  test("merges wrapper and button classes and copies content", async () => {
    render(
      <MessageCopyButton
        content="hello"
        wrapperClassName="custom-wrapper"
        buttonClassName="custom-button"
      />,
    );

    const button = screen.getByRole("button", { name: "Copy text" });
    expect(button.className).toContain("custom-button");
    expect(button.parentElement?.className).toContain("custom-wrapper");

    fireEvent.click(button);

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("hello");
    });
    expect(screen.getByRole("button", { name: "Copied text" })).toBeTruthy();
  });

  test("shows a toast when clipboard copy fails", async () => {
    const consoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    mockWriteText.mockImplementationOnce(async () => {
      throw new Error("denied");
    });

    try {
      render(<MessageCopyButton content="hello" />);
      fireEvent.click(screen.getByRole("button", { name: "Copy text" }));

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith("Failed to copy message text");
      });
    } finally {
      console.error = consoleError;
    }
  });
});
