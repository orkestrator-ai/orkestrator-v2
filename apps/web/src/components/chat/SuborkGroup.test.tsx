import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NativeAgentSuborkBatchView } from "@orkestrator/protocol/suborks";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { NativeMessage } from "./NativeMessage";
import { SuborkGroupActionsContext } from "./subork-context";
import { SuborkGroup } from "./SuborkGroup";

const BATCH: NativeAgentSuborkBatchView = {
  id: "batch-1",
  createdAt: "2026-11-04T00:00:00.000Z",
  status: "running",
  delivery: "waiting",
  suborks: [
    {
      id: "a",
      name: "Opus review",
      agent: "claude",
      modelLabel: "Opus 5.5",
      status: "finished",
      line: "I would ship it.",
      startedAt: "2026-11-04T00:00:00.000Z",
      endedAt: "2026-11-04T00:04:16.000Z",
    },
    {
      id: "b",
      name: "Sol review",
      agent: "codex",
      status: "running",
      startedAt: "2026-11-04T00:00:00.000Z",
    },
    { id: "c", name: "grok 9", status: "failed", line: "No enabled model matches." },
  ],
};

afterEach(() => {
  cleanup();
  useMessagePartExpansionStore.setState({ expandedKeys: new Set() });
});

function renderGroup(
  batch = BATCH,
  actions = { openTranscript: mock(), stop: mock(async () => {}) },
) {
  render(
    <SuborkGroupActionsContext.Provider value={actions}>
      <SuborkGroup batch={batch} expansionKey={`key-${Math.random()}`} />
    </SuborkGroupActionsContext.Provider>,
  );
  return actions;
}

describe("SuborkGroup", () => {
  test("shows the title, the counts and each row's one line", () => {
    renderGroup();
    expect(screen.getAllByText("3 suborks").length).toBeGreaterThan(0);
    expect(screen.getByText("1 working · 1 done · 1 failed")).toBeTruthy();
    expect(screen.getByText("Opus review")).toBeTruthy();
    expect(screen.getByText("I would ship it.")).toBeTruthy();
    // A row with nothing to say yet still says what it is doing.
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("No enabled model matches.")).toBeTruthy();
    expect(screen.getByText("4m 16s")).toBeTruthy();
  });

  test("a failed Stop shows feedback and allows retry", async () => {
    const actions = {
      openTranscript: mock(),
      stop: mock(async () => {
        throw new Error("offline");
      }),
    };
    renderGroup(BATCH, actions);
    fireEvent.click(screen.getByRole("button", { name: "Stop these suborks" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not stop");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop these suborks" }).hasAttribute("disabled"),
      ).toBe(false),
    );
  });

  test("bounds header marks while keeping every target row", () => {
    renderGroup({
      ...BATCH,
      suborks: Array.from({ length: 32 }, (_, i) => ({
        ...BATCH.suborks[1]!,
        id: `target-${i}`,
        name: `Target ${i}`,
      })),
    });
    expect(screen.getByText("+29")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(32);
  });

  test("uses the singular", () => {
    renderGroup({ ...BATCH, suborks: [BATCH.suborks[0]!] });
    expect(screen.getAllByText("1 subork").length).toBeGreaterThan(0);
  });

  test("a row is a named button that opens its transcript", () => {
    const actions = renderGroup();
    const row = screen.getByRole("button", { name: /Sol review\. Running/ });
    fireEvent.click(row);
    expect(actions.openTranscript).toHaveBeenCalledWith("batch-1", "b");
    expect(screen.getByRole("button", { name: /grok 9\. Failed: No enabled/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Opus review, Opus 5\.5\. Finished/ })).toBeTruthy();
  });

  test("the header collapses the rows and says so", () => {
    renderGroup();
    const header = screen.getByRole("button", { name: /3 suborks/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Opus review") === null).toBe(true);
  });

  test("only a running call offers Stop", async () => {
    const actions = renderGroup();
    fireEvent.click(screen.getByRole("button", { name: "Stop these suborks" }));
    await waitFor(() => expect(actions.stop).toHaveBeenCalledWith("batch-1"));
    cleanup();
    renderGroup({ ...BATCH, status: "settled", settledAt: "2026-11-04T00:05:00.000Z" });
    expect(screen.queryByRole("button", { name: "Stop these suborks" }) === null).toBe(true);
  });

  test("says when the answers did not reach the agent", () => {
    renderGroup({ ...BATCH, status: "settled", delivery: "failed", deliveryDetail: "muted" });
    expect(screen.getByText(/could not be delivered to the agent: muted/)).toBeTruthy();
    cleanup();
    renderGroup({ ...BATCH, status: "settled", delivery: "stored" });
    expect(screen.getByText(/did not wake the agent/)).toBeTruthy();
  });

  test("NativeMessage draws a group row", () => {
    render(
      <NativeMessage
        message={{
          id: "subork-group-batch-1",
          role: "system",
          content: "",
          parts: [],
          createdAt: BATCH.createdAt,
          suborkGroup: BATCH,
        }}
      />,
    );
    expect(screen.getByText("Opus review")).toBeTruthy();
  });
});
