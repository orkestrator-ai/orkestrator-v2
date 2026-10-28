import { describe, expect, test } from "bun:test";
import { ticketContentFromSections } from "@orkestrator/protocol/ticket-sections";
import { ticketContentOf } from "./ticket-content";

describe("ticket content projection", () => {
  test("stale sections are rebuilt after an older writer changes text mirrors", () => {
    const content = ticketContentFromSections("work-brief", {
      summary: "Old summary",
      acceptanceCriteria: [
        {
          id: "ac-9",
          text: "Unchanged",
          check: {
            status: "passed",
            evidence: "Checked",
            checkedAt: "2026-10-28",
            source: "verify",
          },
        },
      ],
    });
    const projected = ticketContentOf({
      ...content,
      description: "## Problem\n\nNew problem",
      createdAt: "2026-10-28",
    });
    expect(projected.sections).toEqual({
      problem: "New problem",
      acceptanceCriteria: content.sections.acceptanceCriteria,
    });
    expect(projected.kind).toBe("work-brief");
    expect(ticketContentOf(content).sections).toBe(content.sections);
  });
});
