import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { NativeAgentSessionBranchList } from "@orkestrator/protocol/native-agent";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { SessionBranchPicker } from "./SessionBranchPicker";

afterEach(cleanup);

const ABANDONED: NativeAgentSessionBranchList = {
  activeEntryId: "leaf-kept",
  branches: [
    { entryId: "leaf-old", prompt: "second prompt", entries: 4, updatedAt: "2026-11-09T10:00:00Z" },
  ],
  truncated: false,
};

describe("SessionBranchPicker", () => {
  test("reads branches only when opened, and switches to one by entry id", async () => {
    let current = ABANDONED;
    const listBranches = mock(async () => current);
    const switchBranch = mock(async (_entryId: string, _options: { summarize: boolean }) => {
      current = { activeEntryId: "leaf-old", branches: [], truncated: false };
    });
    renderInAppCommandScope(
      <SessionBranchPicker
        agentLabel="Pi"
        disabled={false}
        listBranches={listBranches}
        switchBranch={switchBranch}
      />,
    );
    expect(listBranches).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Branches" }));
    await screen.findByText("second prompt");
    expect(screen.getByText(/4 entries/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: 'Switch to the branch starting "second prompt"' }),
    );
    // An ordinary switch: no summary, so no model call.
    await waitFor(() =>
      expect(switchBranch).toHaveBeenCalledWith("leaf-old", { summarize: false }),
    );
    // Re-read after the switch: the branch just left would be listed now.
    await screen.findByText(/No other branches/);
    expect(listBranches).toHaveBeenCalledTimes(2);
  });

  test("a summary is opt-in, and the switch says whether one was kept", async () => {
    let release: (() => void) | undefined;
    const switchBranch = mock(
      (_entryId: string, _options: { summarize: boolean }) =>
        new Promise<{ summarized: boolean }>((resolve) => {
          release = () => resolve({ summarized: true });
        }),
    );
    renderInAppCommandScope(
      <SessionBranchPicker
        agentLabel="Pi"
        disabled={false}
        listBranches={async () => ABANDONED}
        switchBranch={switchBranch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));
    await screen.findByText("second prompt");
    const keep = screen.getByRole("checkbox", { name: /Keep a summary of the branch I leave/ });
    expect(keep.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/one extra model call/)).toBeTruthy();

    fireEvent.click(keep);
    fireEvent.click(
      screen.getByRole("button", { name: 'Switch to the branch starting "second prompt"' }),
    );
    await waitFor(() => expect(switchBranch).toHaveBeenCalledWith("leaf-old", { summarize: true }));
    await screen.findByText("Summarizing…");
    expect(keep.hasAttribute("disabled")).toBe(true);
    release!();
    await waitFor(() => expect(screen.queryByText("Summarizing…") === null).toBe(true));
  });

  test("a stopped summarized switch leaves the branch listed and the switch ready again", async () => {
    const listBranches = mock(async () => ABANDONED);
    renderInAppCommandScope(
      <SessionBranchPicker
        agentLabel="Pi"
        disabled={false}
        listBranches={listBranches}
        switchBranch={async () => {
          throw new Error("The branch switch was stopped; the conversation stayed on its branch.");
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));
    await screen.findByText("second prompt");
    fireEvent.click(screen.getByRole("checkbox", { name: /Keep a summary/ }));
    fireEvent.click(
      screen.getByRole("button", { name: 'Switch to the branch starting "second prompt"' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Switch to the branch starting "second prompt"' })
          .textContent,
      ).toBe("Switch"),
    );
    expect(screen.getByText("second prompt")).toBeTruthy();
  });

  test("a parent re-render with a new reader does not re-read", async () => {
    const listBranches = mock(async () => ABANDONED);
    const view = renderInAppCommandScope(
      <SessionBranchPicker
        agentLabel="Pi"
        disabled={false}
        listBranches={() => listBranches()}
        switchBranch={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));
    await screen.findByText("second prompt");
    view.rerender(
      <SessionBranchPicker
        agentLabel="Pi"
        disabled={false}
        listBranches={() => listBranches()}
        switchBranch={async () => {}}
      />,
    );
    await screen.findByText("second prompt");
    expect(listBranches).toHaveBeenCalledTimes(1);
  });

  test("a failed read says why and can be retried", async () => {
    let fail = true;
    const listBranches = mock(async () => {
      if (fail) throw new Error("Pi branch list is temporarily unavailable");
      return ABANDONED;
    });
    renderInAppCommandScope(
      <SessionBranchPicker
        agentLabel="Pi"
        disabled={false}
        listBranches={listBranches}
        switchBranch={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));
    await screen.findByText("Pi branch list is temporarily unavailable");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("second prompt");
  });

  test("switching is disabled while the session is busy", async () => {
    renderInAppCommandScope(
      <SessionBranchPicker
        agentLabel="Pi"
        disabled
        listBranches={async () => ABANDONED}
        switchBranch={async () => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Branches" }).hasAttribute("disabled")).toBe(true);
  });
});
