import { describe, expect, test } from "bun:test";

import { ticketCardTime, ticketTimes } from "./ticket-times";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const exact = (date: Date) => `exact(${date.toISOString()})`;

function ago(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

describe("ticketTimes", () => {
  test("shows Created and Updated, each with its exact time", () => {
    const createdAt = ago(3 * 3600);
    const updatedAt = ago(5 * 60);
    expect(ticketTimes({ createdAt, updatedAt }, NOW, exact)).toEqual({
      created: {
        text: "Created 3h ago",
        title: `Created exact(${createdAt})`,
        dateTime: createdAt,
      },
      updated: {
        text: "Updated 5m ago",
        title: `Updated exact(${updatedAt})`,
        dateTime: updatedAt,
      },
    });
  });

  test("leaves Updated out when it equals Created", () => {
    const createdAt = ago(3 * 3600);
    expect(ticketTimes({ createdAt, updatedAt: createdAt }, NOW, exact).updated).toBeNull();
    expect(ticketTimes({ createdAt, updatedAt: createdAt }, NOW, exact).created?.title).toBe(
      `Created exact(${createdAt})`,
    );
  });

  test("a change within a minute of creation joins Created, keeping its exact time", () => {
    // Images the create dialog attaches a moment later read as the creation.
    const createdAt = ago(3 * 3600);
    const updatedAt = ago(3 * 3600 - 30);
    const times = ticketTimes({ createdAt, updatedAt }, NOW, exact);
    expect(times.updated).toBeNull();
    expect(times.created).toEqual({
      text: "Created 3h ago",
      title: `Created exact(${createdAt})\nUpdated exact(${updatedAt})`,
      dateTime: createdAt,
    });
  });

  test("an update a minute or more after creation is shown", () => {
    const createdAt = ago(3 * 3600);
    expect(
      ticketTimes({ createdAt, updatedAt: ago(3 * 3600 - 60) }, NOW, exact).updated?.text,
    ).toBe("Updated 2h ago");
  });

  test("a ticket from a backend without updatedAt reads as never changed", () => {
    const createdAt = ago(2 * 86400);
    const times = ticketTimes({ createdAt }, NOW, exact);
    expect(times.created?.text).toBe("Created 2d ago");
    expect(times.updated).toBeNull();
    expect(ticketTimes({ createdAt, updatedAt: "not a date" }, NOW, exact).updated).toBeNull();
  });

  test("never shows Invalid Date", () => {
    const times = ticketTimes({ createdAt: "garbage" }, NOW, exact);
    expect(times).toEqual({ created: null, updated: null });
    const updatedOnly = ticketTimes({ createdAt: "", updatedAt: ago(60) }, NOW, exact);
    expect(updatedOnly.created).toBeNull();
    expect(updatedOnly.updated?.text).toBe("Updated 1m ago");
    for (const time of [updatedOnly.updated]) {
      expect(time?.text).not.toContain("Invalid");
      expect(time?.title).not.toContain("Invalid");
    }
  });

  test("past a week the text is a date, not an age", () => {
    const createdAt = ago(30 * 86400);
    const text = ticketTimes({ createdAt }, NOW, exact).created?.text;
    expect(text).toBe(`Created ${new Date(createdAt).toLocaleDateString()}`);
  });

  test("the default exact time is the local date and time", () => {
    const createdAt = ago(60);
    const title = ticketTimes({ createdAt }, NOW).created?.title ?? "";
    expect(title.startsWith("Created ")).toBe(true);
    expect(title).not.toContain("Invalid");
    expect(title).toContain(String(new Date(createdAt).getFullYear()));
  });
});

describe("ticketCardTime", () => {
  test("a changed ticket shows when it was updated, with both exact times", () => {
    const createdAt = ago(86400);
    const updatedAt = ago(3 * 3600);
    expect(ticketCardTime({ createdAt, updatedAt }, NOW, exact)).toEqual({
      text: "Updated 3h ago",
      title: `Updated exact(${updatedAt})\nCreated exact(${createdAt})`,
      dateTime: updatedAt,
    });
  });

  test("an unchanged ticket was last updated when created", () => {
    const createdAt = ago(2 * 3600);
    expect(ticketCardTime({ createdAt, updatedAt: createdAt }, NOW, exact)).toEqual({
      text: "Updated 2h ago",
      title: `Created exact(${createdAt}), not changed since`,
      dateTime: createdAt,
    });
    expect(ticketCardTime({ createdAt }, NOW, exact)?.text).toBe("Updated 2h ago");
  });

  test("a change within a minute of creation still shows its own exact time", () => {
    const createdAt = "2026-11-14T09:00:00.000Z";
    const updatedAt = "2026-11-14T09:00:30.000Z";
    expect(ticketCardTime({ createdAt, updatedAt }, NOW, exact)).toEqual({
      text: "Updated 2h ago",
      title: `Updated exact(${updatedAt})\nCreated exact(${createdAt})`,
      dateTime: updatedAt,
    });
  });

  test("nothing when no time can be read", () => {
    expect(ticketCardTime({ createdAt: "garbage" }, NOW, exact)).toBeNull();
  });
});
