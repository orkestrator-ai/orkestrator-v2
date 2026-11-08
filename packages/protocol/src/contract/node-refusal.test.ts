import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DESKTOP_NODE_REFUSAL_CODES,
  codedMessage,
  messageCode,
  nodeRefusalCode,
} from "./node-refusal";

describe("node refusal message form", () => {
  test("encodes and reads back every desktop refusal code", () => {
    for (const code of DESKTOP_NODE_REFUSAL_CODES) {
      const message = codedMessage(code, "Something was refused.");
      expect(message).toBe(`[${code}] Something was refused.`);
      expect(messageCode(message)).toBe(code);
      expect(nodeRefusalCode(new Error(message))).toBe(code);
    }
  });

  test("reads a code the preload copied to error.code", () => {
    expect(nodeRefusalCode(Object.assign(new Error("x"), { code: "node-scope-closed" }))).toBe(
      "node-scope-closed",
    );
  });

  test("ignores messages and codes outside the code form", () => {
    expect(messageCode("plain failure")).toBeNull();
    expect(messageCode("[Not-A-Code] text")).toBeNull();
    expect(messageCode("[unknown-node]no space")).toBeNull();
    expect(nodeRefusalCode(new Error("plain failure"))).toBeNull();
    expect(nodeRefusalCode("[unknown-node] not an error")).toBeNull();
    expect(nodeRefusalCode(null)).toBeNull();
    expect(nodeRefusalCode(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeNull();
  });

  test("imports nothing, so the sandboxed preload can bundle it", () => {
    const source = readFileSync(new URL("./node-refusal.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^import\s/m);
  });
});
