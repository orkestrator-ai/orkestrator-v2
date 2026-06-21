import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mockWriteContainerFile = mock(async () => {});
const mockWriteLocalFile = mock(async () => "/tmp/file.png");

mock.module("@/lib/backend", () => ({
  writeContainerFile: mockWriteContainerFile,
  writeLocalFile: mockWriteLocalFile,
}));

import { ComposeBar } from "../../../src/components/terminal/ComposeBar";
import { useTerminalSessionStore } from "../../../src/stores/terminalSessionStore";

const SESSION_KEY = "container-1:tab-1";

function renderComposeBar(
  overrides: Partial<Parameters<typeof ComposeBar>[0]> = {},
) {
  const onClose = mock(() => {});
  const onSend = mock(() => {});
  const onAddressAll = mock(() => {});

  const result = render(
    <ComposeBar
      sessionKey={SESSION_KEY}
      isOpen
      onClose={onClose}
      onSend={onSend}
      containerId="container-1"
      worktreePath={null}
      onAddressAll={onAddressAll}
      {...overrides}
    />,
  );

  return { ...result, onClose, onSend, onAddressAll };
}

describe("Terminal ComposeBar", () => {
  beforeEach(() => {
    mockWriteContainerFile.mockReset();
    mockWriteLocalFile.mockReset();
    useTerminalSessionStore.setState({
      composeDraftText: new Map(),
      composeDraftImages: new Map(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("hides Address all by default", () => {
    renderComposeBar();

    expect(screen.queryByRole("button", { name: "Address all" })).toBeNull();
  });

  test("delegates Address all to the review follow-up handler", () => {
    const { onAddressAll, onSend } = renderComposeBar({ showAddressAll: true });

    fireEvent.click(screen.getByRole("button", { name: "Address all" }));

    expect(onAddressAll).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });
});
