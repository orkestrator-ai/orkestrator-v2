import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  checkDeclaration,
  checkPropertyName,
  checkStyleSet,
  cssSupports,
  formatInline,
  splitImportant,
} from "./design-css";

const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CSS");

function setSupports(implementation: ((property: string, value: string) => boolean) | undefined) {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: implementation ? { supports: implementation } : {},
  });
}

afterEach(() => {
  if (cssDescriptor) Object.defineProperty(globalThis, "CSS", cssDescriptor);
  else delete (globalThis as unknown as Record<string, unknown>).CSS;
});

describe("design-css", () => {
  test("splitImportant and formatInline round-trip the priority suffix", () => {
    expect(splitImportant(" 10px  !important ")).toEqual({ value: "10px", important: true });
    expect(splitImportant("10px ! IMPORTANT")).toEqual({ value: "10px", important: true });
    expect(splitImportant("10px")).toEqual({ value: "10px", important: false });
    expect(formatInline("10px", "important")).toBe("10px !important");
    expect(formatInline("10px")).toBe("10px");
    expect(formatInline(undefined)).toBe("");
  });

  test("validates values with CSS.supports without the !important suffix", () => {
    const supports = mock((_property: string, value: string) => value !== "bogus");
    setSupports(supports);
    expect(checkDeclaration("width", "10px !important")).toEqual({
      ok: true,
      value: "10px",
      important: true,
    });
    expect(supports).toHaveBeenCalledWith("width", "10px");
    expect(checkDeclaration("width", "bogus")).toEqual({
      ok: false,
      error: "Not a valid value for width",
    });
    expect(checkDeclaration("width", "!important")).toMatchObject({ ok: false });
    expect(checkDeclaration("width", "red; color: blue")).toMatchObject({ ok: false });
  });

  test("empty values remove the declaration", () => {
    setSupports((_property, value) => value === "inherit");
    expect(checkDeclaration("width", "")).toEqual({ ok: true, remove: true });
    expect(checkDeclaration("width", "   ")).toEqual({ ok: true, remove: true });
    expect(checkDeclaration("width", null)).toEqual({ ok: true, remove: true });
  });

  test("custom properties are accepted with a no-visible-effect note", () => {
    setSupports(() => true);
    const result = checkDeclaration("--brand", "#123456");
    expect(result).toMatchObject({ ok: true, value: "#123456" });
    expect(result.ok && !result.remove && result.note).toContain("var()");
    setSupports(() => false);
    expect(checkDeclaration("--brand", "(")).toMatchObject({ ok: false });
  });

  test("shorthands carry an expansion note", () => {
    setSupports(() => true);
    expect(checkDeclaration("padding", "4px 8px")).toMatchObject({
      ok: true,
      note: "Shorthand: sets every related longhand",
    });
  });

  test("accepts values when the environment cannot validate", () => {
    setSupports(undefined);
    expect(cssSupports("width", "x")).toBeUndefined();
    expect(checkDeclaration("width", "anything")).toMatchObject({ ok: true });
    setSupports(() => {
      throw new Error("parser unavailable");
    });
    expect(checkDeclaration("width", "anything")).toMatchObject({ ok: true });
  });

  test("validates property names and length limits", () => {
    setSupports((property) => property !== "made-up");
    expect(checkPropertyName("")).toBe("Enter a property name");
    expect(checkPropertyName("Bad Name")).toContain("custom property");
    expect(checkPropertyName("made-up")).toBe("This browser does not support that property");
    expect(checkPropertyName("--ok_1")).toBeUndefined();
    expect(checkPropertyName(`--${"a".repeat(120)}`)).toBe("Property name is too long");
    expect(checkDeclaration("width", "x".repeat(2049))).toMatchObject({ ok: false });
  });

  test("checkStyleSet reports every invalid property in the set", () => {
    setSupports((_property, value) => value !== "bogus");
    expect(checkStyleSet({ width: "bogus", height: "10px", color: null, top: "bogus" })).toEqual({
      width: "Not a valid value for width",
      top: "Not a valid value for top",
    });
  });
});
