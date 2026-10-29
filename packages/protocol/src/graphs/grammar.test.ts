import { describe, expect, test } from "bun:test";
import {
  GRAPH_TEMPLATE_BOUNDS as B,
  graphUtf8Bytes,
  isGraphFieldPath,
  isGraphId,
  isGraphKey,
  parseGraphTypeRef,
} from "./grammar";

describe("graph grammar", () => {
  test("ids are kebab-case slugs", () => {
    for (const id of ["plan", "has-findings", "review2", "a-1-b"]) expect(isGraphId(id)).toBe(true);
    for (const id of ["Plan", "has_findings", "-a", "a-", "a--b", "1a", "", "a".repeat(65)]) {
      expect(isGraphId(id)).toBe(false);
    }
  });

  test("keys are identifiers usable in tool names and paths", () => {
    for (const key of ["code", "autoFix", "design_brief", "v2"]) expect(isGraphKey(key)).toBe(true);
    for (const key of ["Code", "design-brief", "_x", "2v", "", "a".repeat(B.maxKeyChars + 1)]) {
      expect(isGraphKey(key)).toBe(false);
    }
  });

  test("field paths are dotted segments", () => {
    for (const path of [
      "report.issues",
      "params.autoFix",
      "verify.verdict.complete",
      "has-findings.x",
    ]) {
      expect(isGraphFieldPath(path)).toBe(true);
    }
    for (const path of ["", "a..b", ".a", "a.", "a[0]", "a b", "0.a"]) {
      expect(isGraphFieldPath(path)).toBe(false);
    }
  });

  test("type refs carry a name, a major version and a list depth", () => {
    expect(parseGraphTypeRef("review-report@1")).toEqual({
      name: "review-report",
      version: 1,
      listDepth: 0,
    });
    expect(parseGraphTypeRef("list<finding@12>")).toEqual({
      name: "finding",
      version: 12,
      listDepth: 1,
    });
    expect(parseGraphTypeRef("list<list<finding@1>>")?.listDepth).toBe(2);
    for (const ref of [
      "finding",
      "finding@0",
      "finding@01",
      "finding@1000",
      "list<finding@1",
      "finding@1>",
      "list<finding@1>>",
      "list<list<list<finding@1>>>",
      "map<finding@1>",
      "Finding@1",
    ]) {
      expect(parseGraphTypeRef(ref)).toBeNull();
    }
  });

  test("text is measured in UTF-8 bytes", () => {
    expect(graphUtf8Bytes("abc")).toBe(3);
    expect(graphUtf8Bytes("é")).toBe(2);
    expect(graphUtf8Bytes("😀")).toBe(4);
  });
});
