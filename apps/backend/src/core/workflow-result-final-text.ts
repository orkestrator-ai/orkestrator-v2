import type { WorkflowResultValidationIssue } from "@orkestrator/protocol/workflow-results";

const PLACEHOLDER_VALUES = new Set([
  "asdf",
  "dummy",
  "lorem ipsum",
  "placeholder",
  "probe",
  "sample",
  "tbd",
  "test",
  "testing",
  "todo",
  // Filler a model uses to shrink a payload until a call goes through.
  "x",
  "xx",
  "xxx",
]);
const PLACEHOLDER_PHRASE =
  /^(?:(?:this|that) is (?:a )?)?(?:dummy|placeholder|probe|sample|tbd|test|testing|todo)(?: (?:content|only|result|value))?[.!]?$/;

export function inspectFinalText(
  issues: WorkflowResultValidationIssue[],
  candidate: unknown,
  path: string,
): void {
  if (typeof candidate !== "string") return;
  const normalized = candidate.trim().toLocaleLowerCase("en-US");
  if (!PLACEHOLDER_VALUES.has(normalized) && !PLACEHOLDER_PHRASE.test(normalized)) return;
  issues.push({
    path: path.slice(0, 256),
    code: "placeholder_value",
    message: "A workflow result must contain final content, not a probe or placeholder.",
  });
}
