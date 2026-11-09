import { expect, test } from "bun:test";
import { parseAutoPipelineResult, parseAutoPipelineTicket } from "./auto-pipeline.js";
import {
  confirmAutoPipelineCommand,
  draftAutoPipelineCommand,
} from "./contract/domains/pipelines/commands.js";

const ticket = {
  title: "Feature",
  description: "Summary, problem and context",
  acceptanceCriteria: ["Persists on reload"],
};
test("manual drafting and confirmation have schema contracts", () => {
  expect(draftAutoPipelineCommand.name).toBe("draft_auto_pipeline");
  expect(confirmAutoPipelineCommand.name).toBe("confirm_auto_pipeline");
  expect(parseAutoPipelineTicket(ticket)).toEqual(ticket);
  expect(() => parseAutoPipelineTicket({ ...ticket, acceptanceCriteria: [] })).toThrow();
});
test("draft result requires the ticket and observed Build notes together", () => {
  const notes = {
    summary: "Finished",
    workDone: ["file.ts"],
    decisions: [],
    tests: [],
    notDone: [],
  };
  expect(parseAutoPipelineResult({ ...ticket, notes })).toEqual({ ...ticket, notes });
  expect(() =>
    parseAutoPipelineResult({ ...ticket, notes: { summary: "Missing evidence" } }),
  ).toThrow();
  expect(() => parseAutoPipelineResult({ ...ticket, title: "x".repeat(241), notes })).toThrow();
});
