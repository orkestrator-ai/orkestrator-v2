import { describe, expect, test } from "bun:test";
import { ticketLabelClassName } from "./ticket-label-style";

describe("ticketLabelClassName", () => {
  test("gives improvement and insight their fixed, different colours whatever the case", () => {
    expect(ticketLabelClassName("improvement")).toContain("sky");
    expect(ticketLabelClassName("insight")).toContain("violet");
    expect(ticketLabelClassName("Improvement")).toBe(ticketLabelClassName("IMPROVEMENT"));
    expect(ticketLabelClassName("Insight")).toBe(ticketLabelClassName("insight"));
  });

  test("hashes other names to the same chip every time", () => {
    expect(ticketLabelClassName("billing")).toBe(ticketLabelClassName("Billing"));
    expect(ticketLabelClassName("billing")).toBe(ticketLabelClassName("billing"));
  });

  test("a name that is also an Object property still gets a chip", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(ticketLabelClassName(name)).toMatch(/^border-\w+-500\/30 /);
    }
  });
});
