import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { ContainerLogViewer } from "./ContainerLogViewer";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

function install(reads: Array<Record<string, unknown>>) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let index = 0;
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "open_container_logs") {
      return { subscriptionId: "sub-1", sourceId: "source-1", cursor: 0 };
    }
    if (command === "read_container_logs") {
      const next = reads[Math.min(index, reads.length - 1)];
      index += 1;
      return next;
    }
    return undefined;
  });
  return calls;
}

const records = (...texts: string[]) => texts.map((text, index) => ({ seq: index + 1, text }));

describe("container log viewer", () => {
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("shows followed output and releases the subscription when hidden", async () => {
    const calls = install([
      {
        kind: "records",
        sourceId: "source-1",
        records: records("hello\n"),
        cursor: 1,
        ended: false,
      },
    ]);
    const view = render(<ContainerLogViewer containerId="container-1" />);
    await waitFor(() =>
      expect(screen.getByLabelText("Container log").textContent).toContain("hello"),
    );
    expect(screen.getByRole("status").textContent).toBe("Following");
    view.unmount();
    await waitFor(() =>
      expect(calls.some((call) => call.command === "close_container_logs")).toBe(true),
    );
    expect(calls.find((call) => call.command === "close_container_logs")?.args).toEqual({
      subscriptionId: "sub-1",
    });
  });

  test("a gap says output was dropped; a stopped container says the log ended", async () => {
    install([
      { kind: "gap", sourceId: "source-1", records: records("latest\n"), cursor: 9, ended: true },
      { kind: "records", sourceId: "source-1", records: [], cursor: 9, ended: true },
    ]);
    render(<ContainerLogViewer containerId="container-1" />);
    await screen.findByText(/only the most recent part is shown/);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("log ended"), {
      timeout: 3_000,
    });
    expect(screen.getByLabelText("Container log").textContent).toContain("latest");
    expect(screen.getByRole("button", { name: "Follow again" })).toBeTruthy();
  });

  test("a failed read is shown as disconnected and can be followed again", async () => {
    let fail = true;
    const calls: string[] = [];
    invokeMock.mockClear();
    invokeMock.mockImplementation(async (command: string) => {
      calls.push(command);
      if (command === "open_container_logs") {
        return { subscriptionId: "sub-2", sourceId: "source-2", cursor: 0 };
      }
      if (command === "read_container_logs") {
        if (fail) throw new Error("The log subscription has expired.");
        return { kind: "records", sourceId: "source-2", records: [], cursor: 0, ended: false };
      }
      return undefined;
    });
    render(<ContainerLogViewer containerId="container-1" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Disconnected"));
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Follow again" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Following"));
    expect(calls.filter((command) => command === "open_container_logs")).toHaveLength(2);
  });
});
