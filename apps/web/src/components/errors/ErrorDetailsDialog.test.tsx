import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  mockToastError,
  mockToastSuccess,
} from "../../../../../tests/mocks/sonner";
import { useErrorDialogStore } from "@/stores";
import { ErrorDetailsDialog } from "./ErrorDetailsDialog";

const writeText = mock(async (_text: string) => undefined);
const clipboardDescriptor = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  "clipboard",
);

describe("ErrorDetailsDialog", () => {
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    mockToastError.mockClear();
    mockToastSuccess.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    useErrorDialogStore.setState({ error: null });
  });

  afterEach(() => {
    cleanup();
    useErrorDialogStore.setState({ error: null });
    delete (navigator as unknown as Record<string, unknown>).clipboard;
    if (clipboardDescriptor) {
      Object.defineProperty(
        Navigator.prototype,
        "clipboard",
        clipboardDescriptor,
      );
    }
  });

  test("copies full details and the optional prompt independently", async () => {
    const timestamp = new Date("2026-07-28T12:00:00.000Z");
    useErrorDialogStore.setState({
      error: {
        title: "Build failed",
        message: "compiler output",
        initialPrompt: "retry prompt",
        timestamp,
      },
    });
    render(<ErrorDetailsDialog />);

    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    fireEvent.click(copyButtons[0]!);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("retry prompt")
    );
    fireEvent.click(copyButtons[1]!);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        [
          "Build failed",
          "",
          "compiler output",
          "",
          "Initial Prompt:",
          "retry prompt",
          "",
          `Timestamp: ${timestamp.toISOString()}`,
        ].join("\n"),
      )
    );
    expect(mockToastSuccess).toHaveBeenCalledTimes(2);
  });

  test("omits prompt controls and reports clipboard failures", async () => {
    writeText.mockRejectedValue(new Error("clipboard unavailable"));
    useErrorDialogStore.setState({
      error: {
        title: "Failure",
        message: "details",
        timestamp: new Date("2026-07-28T12:00:00.000Z"),
      },
    });
    render(<ErrorDetailsDialog />);

    expect(screen.queryByText("Initial Prompt") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Failed to copy to clipboard",
      )
    );
  });
});
