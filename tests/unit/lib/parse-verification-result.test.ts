import { describe, expect, test } from "bun:test";
import { parseVerificationResult } from "../../../apps/web/src/lib/parse-verification-result";

const assistant = (content: string) => [{ role: "assistant" as const, parts: [{ type: "text", content }] }];

describe("parseVerificationResult", () => {
  test("fails clearly when no assistant response exists", () => {
    expect(parseVerificationResult([])).toEqual({
      verdict: "fail",
      feedback: "No verification response received",
    });
  });

  test("parses fenced and raw structured verdicts", () => {
    expect(parseVerificationResult(assistant('```json\n{"complete":true,"rationale":"done"}\n```'))).toEqual({
      verdict: "pass",
      feedback: "done",
    });
    expect(parseVerificationResult(assistant('{"complete":false,"rationale":"missing tests"}'))).toEqual({
      verdict: "fail",
      feedback: "missing tests",
    });
  });

  test("falls back to the legacy first-line verdict for malformed JSON", () => {
    expect(parseVerificationResult(assistant("YES\nEverything passed"))).toEqual({
      verdict: "pass",
      feedback: "YES\nEverything passed",
    });
    expect(parseVerificationResult(assistant("```json\n{broken}\n```"))).toMatchObject({ verdict: "fail" });
  });

  test("uses only the last assistant message and joins its text parts", () => {
    expect(parseVerificationResult([
      ...assistant("YES old"),
      { role: "user", parts: [{ type: "text", content: "ignored" }] },
      { role: "assistant", parts: [{ type: "tool" }, { type: "text", content: "NO" }, { type: "text", content: "reason" }] },
    ])).toEqual({ verdict: "fail", feedback: "NO\nreason" });
  });
});
