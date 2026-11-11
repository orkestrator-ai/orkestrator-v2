import { describe, expect, test } from "bun:test";

import { buildPipelineFixture } from "@/test/build-pipeline-fixture";

import {
  defaultTicketViewTab,
  ticketChecksLabel,
  ticketNotesAvailability,
  ticketPrState,
} from "./ticket-view-model";

const NOTES = { summary: "What changed", updates: [] } as never;

describe("ticketNotesAvailability", () => {
  test("a linked build with Notes opens them", () => {
    const pipeline = buildPipelineFixture({ keyInformation: NOTES });
    expect(ticketNotesAvailability({}, pipeline)).toEqual({ available: true, pipeline });
  });

  test("says why there are none: no build, nothing written yet, or built elsewhere", () => {
    expect(ticketNotesAvailability({}, undefined)).toEqual({
      available: false,
      reason: "No build has run for this ticket yet.",
    });
    expect(ticketNotesAvailability({}, buildPipelineFixture({}))).toEqual({
      available: false,
      reason: "Its build has not written Notes yet.",
    });
    expect(
      ticketNotesAvailability(
        {
          sync: {
            seq: 1,
            revs: {},
            work: { nodeId: "bk_leaf", nodeName: "beelink", buildPipelineId: "p", updatedAt: "" },
          },
        },
        undefined,
      ),
    ).toEqual({ available: false, reason: "Built on beelink: open its Notes there." });
  });
});

describe("defaultTicketViewTab", () => {
  const withNotes = { available: true, pipeline: buildPipelineFixture({}) } as const;
  const without = { available: false, reason: "none" } as const;

  test("a Review ticket with Notes opens on Notes", () => {
    expect(defaultTicketViewTab("review", withNotes)).toBe("notes");
  });

  test("every other ticket opens on Ticket", () => {
    expect(defaultTicketViewTab("review", without)).toBe("ticket");
    for (const column of ["backlog", "in-progress", "done"] as const) {
      expect(defaultTicketViewTab(column, withNotes)).toBe("ticket");
    }
  });
});

describe("ticketPrState", () => {
  const open = { prUrl: "https://github.com/o/r/pull/1", prState: "open" as const };

  test("only a ready pull request can be merged", () => {
    expect(
      ticketPrState({ ...open, readiness: { ready: true }, checkSummary: null }),
    ).toMatchObject({ label: "Ready to merge", tone: "good", mergeable: true });
    for (const reason of [
      "draft",
      "conflicts",
      "checks-pending",
      "checks-failing",
      "stale",
    ] as const) {
      expect(
        ticketPrState({ ...open, readiness: { ready: false, reason }, checkSummary: null })
          .mergeable,
      ).toBe(false);
    }
  });

  test("names each state the bar shows", () => {
    const label = (reason: Parameters<typeof ticketPrState>[0]["readiness"]) =>
      ticketPrState({ ...open, readiness: reason, checkSummary: null }).label;
    expect(label({ ready: false, reason: "draft" })).toBe("Draft");
    expect(label({ ready: false, reason: "conflicts" })).toBe("Conflicts");
    expect(label({ ready: false, reason: "checks-pending" })).toBe("Checks running");
    expect(label({ ready: false, reason: "checks-failing" })).toBe("Checks failed");
    expect(label({ ready: false, reason: "stale" })).toBe("Open · checking");
    expect(label(null)).toBe("Open");
    expect(
      ticketPrState({ prUrl: open.prUrl, prState: "merged", readiness: null, checkSummary: null }),
    ).toMatchObject({ label: "Merged", mergeable: false });
    expect(
      ticketPrState({ prUrl: open.prUrl, prState: "closed", readiness: null, checkSummary: null })
        .label,
    ).toBe("Closed without merging");
    expect(
      ticketPrState({ prUrl: null, prState: null, readiness: null, checkSummary: null }).label,
    ).toBe("No pull request");
  });

  test("checks read as passed, running or failed", () => {
    expect(ticketChecksLabel({ passed: 3, total: 3, pending: 0 })).toBe("3 checks passed");
    expect(ticketChecksLabel({ passed: 1, total: 3, pending: 2 })).toBe("2 of 3 checks running");
    expect(ticketChecksLabel({ passed: 1, total: 3, pending: 0 })).toBe("2 of 3 checks failed");
    expect(ticketChecksLabel(null)).toBeNull();
  });
});
