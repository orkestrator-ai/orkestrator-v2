import { describe, expect, test } from "bun:test";
import {
  canonicalTicketLabels,
  isTicketLabelList,
  normalizeTicketLabelColor,
  normalizeTicketLabelName,
  normalizeTicketLabels,
  summarizeTicketLabels,
  TICKET_LABEL_LIMITS,
} from "./ticket-labels.js";

describe("ticket label names", () => {
  test("collapse whitespace and refuse empty, long or control-character names", () => {
    expect(normalizeTicketLabelName("  needs   design\t")).toBe("needs design");
    expect(() => normalizeTicketLabelName("   ")).toThrow("must not be empty");
    expect(() =>
      normalizeTicketLabelName("x".repeat(TICKET_LABEL_LIMITS.maxNameLength + 1)),
    ).toThrow("at most");
    expect(() => normalizeTicketLabelName("bad\u0000name")).toThrow("control characters");
    expect(() => normalizeTicketLabelName(3)).toThrow("must be a string");
  });

  test("a ticket's list drops case-insensitive duplicates and is bounded", () => {
    expect(normalizeTicketLabels(["Bug", "bug", " UI ", "ui"])).toEqual(["Bug", "UI"]);
    expect(() =>
      normalizeTicketLabels(
        Array.from({ length: TICKET_LABEL_LIMITS.maxPerTicket + 1 }, (_, i) => `l${i}`),
      ),
    ).toThrow(`at most ${TICKET_LABEL_LIMITS.maxPerTicket}`);
    expect(() => normalizeTicketLabels("bug")).toThrow("array");
  });

  test("names the project already uses keep their spelling", () => {
    expect(canonicalTicketLabels(["BUG", "new one"], ["bug", "Docs"])).toEqual(["bug", "new one"]);
  });

  test("only canonical lists pass as stored labels", () => {
    expect(isTicketLabelList(["bug", "ui"])).toBe(true);
    expect(isTicketLabelList([])).toBe(true);
    expect(isTicketLabelList(["bug", "Bug"])).toBe(false);
    expect(isTicketLabelList([" bug"])).toBe(false);
    expect(isTicketLabelList("bug")).toBe(false);
  });

  test("colours are #rrggbb, stored lower case", () => {
    expect(normalizeTicketLabelColor("#A855F7")).toBe("#a855f7");
    expect(() => normalizeTicketLabelColor("purple")).toThrow("#rrggbb");
  });
});

describe("summarizeTicketLabels", () => {
  test("lists the catalogue first, then labels only tickets carry, with counts", () => {
    const summary = summarizeTicketLabels(
      [
        { name: "bug", color: "#ff0000", createdAt: "2026-11-01T00:00:00.000Z" },
        { name: "unused", createdAt: "2026-11-02T00:00:00.000Z" },
      ],
      [{ labels: ["bug", "zeta"] }, { labels: ["Bug", "alpha"] }, {}],
    );
    expect(summary).toEqual([
      { name: "bug", color: "#ff0000", createdAt: "2026-11-01T00:00:00.000Z", ticketCount: 2 },
      { name: "unused", createdAt: "2026-11-02T00:00:00.000Z", ticketCount: 0 },
      { name: "alpha", ticketCount: 1 },
      { name: "zeta", ticketCount: 1 },
    ]);
  });
});
