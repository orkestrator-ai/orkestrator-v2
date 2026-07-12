import { describe, test, expect } from "bun:test";
import { cn } from "../../../apps/web/src/lib/utils";

describe("cn utility", () => {
  test("merges class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  test("handles undefined and null values", () => {
    expect(cn("foo", undefined, null, "bar")).toBe("foo bar");
  });

  test("handles empty strings", () => {
    expect(cn("foo", "", "bar")).toBe("foo bar");
  });

  test("merges tailwind classes intelligently", () => {
    // twMerge should prefer the later conflicting class
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
    expect(cn("p-4", "p-8")).toBe("p-8");
    expect(cn("bg-red-500", "bg-blue-500")).toBe("bg-blue-500");
  });

  test("handles conditional classes", () => {
    const isActive = true;
    const isDisabled = false;

    expect(cn("base", isActive && "active", isDisabled && "disabled")).toBe(
      "base active"
    );
  });

  test("handles array of classes", () => {
    expect(cn(["foo", "bar"])).toBe("foo bar");
    expect(cn(["foo", "bar"], "baz")).toBe("foo bar baz");
  });

  test("handles object syntax", () => {
    expect(cn({ foo: true, bar: false, baz: true })).toBe("foo baz");
  });

  test("handles mixed inputs", () => {
    expect(
      cn("base", ["flex", "items-center"], { "text-red-500": true, hidden: false })
    ).toBe("base flex items-center text-red-500");
  });

  test("handles no inputs", () => {
    expect(cn()).toBe("");
  });
});
