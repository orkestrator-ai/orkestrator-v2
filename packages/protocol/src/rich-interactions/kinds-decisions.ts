/**
 * Decisions and scope (features 1-4): visual choices, rich forms, editable
 * plans and selectable collections.
 *
 * Browser-safe.
 */
import {
  readFormSpec,
  readFormValues,
  summarizeFormValues,
  type FormSpec,
  type FormValues,
} from "./form.js";
import { followup, revise, type RichKindModule } from "./kind-module.js";
import { clip, describeContentRef, readContentRef, type ContentRef } from "./refs.js";
import {
  arr,
  bool,
  fail,
  id,
  isRecord,
  num,
  obj,
  oneOf,
  optArr,
  optBool,
  optNum,
  optStr,
  str,
  uniqueIds,
} from "./validate.js";

const TEXT = 4_000;
const LABEL = 200;

// ---------------------------------------------------------------------------
// 01. Visual decision cards

export const OPTION_PREVIEW_KINDS = ["image", "artifact", "diagram", "diff", "text"] as const;
export type OptionPreviewKind = (typeof OPTION_PREVIEW_KINDS)[number];

/** A typed, bounded preview. Images and artifacts are references; diagram/diff/text carry bounded source. */
export interface OptionPreviewRef {
  kind: OptionPreviewKind;
  /** Accessible description; also the fallback when the preview cannot load. */
  description: string;
  ref?: ContentRef;
  /** Mermaid source (diagram), unified diff (diff) or plain text (text). */
  source?: string;
}

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  tradeoffs?: string[];
  preview?: OptionPreviewRef;
}

export interface ChoiceQuestion {
  id: string;
  prompt: string;
  multiple: boolean;
  /** Offer "Something else" free text. */
  allowOther: boolean;
  required: boolean;
  options: ChoiceOption[];
  recommendedOptionId?: string;
  recommendationRationale?: string;
}

export interface ChoiceSpec {
  /** One question per independently chosen aspect (explicit subchoices). */
  questions: ChoiceQuestion[];
  /** Offer an additional-constraint field. */
  allowConstraints: boolean;
}

export interface ChoiceResult {
  answers: Array<{ questionId: string; optionIds: string[]; other?: string }>;
  constraints?: string;
}

function readPreview(value: unknown, path: string): OptionPreviewRef {
  const record = obj(value, path, ["kind", "description", "ref", "source"]);
  const kind = oneOf(record.kind, `${path}.kind`, OPTION_PREVIEW_KINDS);
  const description = str(record.description, `${path}.description`, 1_000, 1);
  const ref = record.ref === undefined ? undefined : readContentRef(record.ref, `${path}.ref`);
  const source = optStr(record.source, `${path}.source`, 60_000);
  if ((kind === "image" || kind === "artifact") && !ref)
    fail(`${path}.ref`, `a ${kind} preview needs a reference`);
  if (
    kind === "image" &&
    ref &&
    ref.kind !== "workspace-image" &&
    ref.kind !== "artifact" &&
    ref.kind !== "file"
  ) {
    fail(`${path}.ref.kind`, "an image preview references a workspace image, file or artifact");
  }
  if (kind === "artifact" && ref?.kind !== "artifact")
    fail(`${path}.ref.kind`, "an artifact preview references an artifact revision");
  if ((kind === "diagram" || kind === "diff" || kind === "text") && source === undefined) {
    fail(`${path}.source`, `a ${kind} preview needs its source`);
  }
  return {
    kind,
    description,
    ...(ref ? { ref } : {}),
    ...(source === undefined ? {} : { source }),
  };
}

function readChoiceQuestion(value: unknown, path: string): ChoiceQuestion {
  const record = obj(value, path, [
    "id",
    "prompt",
    "multiple",
    "allowOther",
    "required",
    "options",
    "recommendedOptionId",
    "recommendationRationale",
  ]);
  const options = arr(
    record.options,
    `${path}.options`,
    8,
    (item, itemPath) => {
      const option = obj(item, itemPath, ["id", "label", "description", "tradeoffs", "preview"]);
      const description = optStr(option.description, `${itemPath}.description`, TEXT);
      const tradeoffs = optArr(option.tradeoffs, `${itemPath}.tradeoffs`, 10, (t, p) =>
        str(t, p, 500, 1),
      );
      return {
        id: id(option.id, `${itemPath}.id`, 64),
        label: str(option.label, `${itemPath}.label`, LABEL, 1),
        ...(description === undefined ? {} : { description }),
        ...(tradeoffs === undefined ? {} : { tradeoffs }),
        ...(option.preview === undefined
          ? {}
          : { preview: readPreview(option.preview, `${itemPath}.preview`) }),
      };
    },
    2,
  );
  uniqueIds(options, `${path}.options`, (option) => option.id);
  const recommendedOptionId = optStr(record.recommendedOptionId, `${path}.recommendedOptionId`, 64);
  const rationale = optStr(record.recommendationRationale, `${path}.recommendationRationale`, TEXT);
  if (recommendedOptionId !== undefined) {
    if (!options.some((option) => option.id === recommendedOptionId))
      fail(`${path}.recommendedOptionId`, "must name an option");
    if (!rationale?.trim())
      fail(`${path}.recommendationRationale`, "a recommendation needs its rationale");
  }
  return {
    id: id(record.id, `${path}.id`, 64),
    prompt: str(record.prompt, `${path}.prompt`, TEXT, 1),
    multiple: record.multiple === undefined ? false : bool(record.multiple, `${path}.multiple`),
    allowOther:
      record.allowOther === undefined ? true : bool(record.allowOther, `${path}.allowOther`),
    required: record.required === undefined ? true : bool(record.required, `${path}.required`),
    options,
    ...(recommendedOptionId === undefined
      ? {}
      : { recommendedOptionId, recommendationRationale: rationale! }),
  };
}

export const choiceKind: RichKindModule<ChoiceSpec, ChoiceResult> = {
  kind: "choice",
  features: [1],
  title: "Visual decision",
  actions: [followup("submit", "Use this direction")],
  customFollowups: false,
  repeatable: false,
  readSpec(value, path) {
    const record = obj(value, path, ["questions", "allowConstraints"]);
    const questions = arr(record.questions, `${path}.questions`, 6, readChoiceQuestion, 1);
    uniqueIds(questions, `${path}.questions`, (q) => q.id);
    return {
      questions,
      allowConstraints:
        record.allowConstraints === undefined
          ? true
          : bool(record.allowConstraints, `${path}.allowConstraints`),
    };
  },
  readResult(spec, _action, value, path) {
    const record = obj(value, path, ["answers", "constraints"]);
    const answers = arr(
      record.answers,
      `${path}.answers`,
      spec.questions.length,
      (item, itemPath) => {
        const answer = obj(item, itemPath, ["questionId", "optionIds", "other"]);
        const questionId = id(answer.questionId, `${itemPath}.questionId`, 64);
        const question = spec.questions.find((q) => q.id === questionId);
        if (!question) fail(`${itemPath}.questionId`, "is not a question of this request");
        const optionIds = arr(
          answer.optionIds,
          `${itemPath}.optionIds`,
          question.options.length,
          (o, p) => {
            const optionId = id(o, p, 64);
            if (!question.options.some((option) => option.id === optionId))
              fail(p, "is not an option of this question");
            return optionId;
          },
        );
        if (new Set(optionIds).size !== optionIds.length)
          fail(`${itemPath}.optionIds`, "must not repeat an option");
        const other = optStr(answer.other, `${itemPath}.other`, TEXT);
        if (other !== undefined && !question.allowOther)
          fail(`${itemPath}.other`, "this question does not accept another answer");
        if (!question.multiple && optionIds.length + (other?.trim() ? 1 : 0) > 1)
          fail(itemPath, "this question takes one answer");
        return { questionId, optionIds, ...(other?.trim() ? { other: other.trim() } : {}) };
      },
    );
    uniqueIds(answers, `${path}.answers`, (a) => a.questionId);
    for (const question of spec.questions) {
      const answer = answers.find((a) => a.questionId === question.id);
      if (question.required && (!answer || (answer.optionIds.length === 0 && !answer.other))) {
        fail(`${path}.answers`, `question ${question.id} needs an answer`);
      }
    }
    const constraints = optStr(record.constraints, `${path}.constraints`, TEXT);
    if (constraints?.trim() && !spec.allowConstraints)
      fail(`${path}.constraints`, "this request does not take constraints");
    return { answers, ...(constraints?.trim() ? { constraints: constraints.trim() } : {}) };
  },
  summarize(spec, _action, result) {
    const lines: string[] = [];
    for (const answer of result.answers) {
      const question = spec.questions.find((q) => q.id === answer.questionId)!;
      lines.push(`Question "${clip(question.prompt, 200)}" [${question.id}]:`);
      for (const optionId of answer.optionIds) {
        const option = question.options.find((o) => o.id === optionId)!;
        const preview = option.preview?.ref
          ? ` — preview ${describeContentRef(option.preview.ref)}`
          : "";
        lines.push(`  - chose "${option.label}" [${option.id}]${preview}`);
      }
      if (answer.other) lines.push(`  - something else: ${JSON.stringify(answer.other)}`);
    }
    if (result.constraints)
      lines.push(`Additional constraint from the user: ${JSON.stringify(result.constraints)}`);
    return lines;
  },
  fallback(spec) {
    return spec.questions
      .map(
        (q) =>
          `${q.prompt}\n${q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")}`,
      )
      .join("\n\n");
  },
};

// ---------------------------------------------------------------------------
// 02. Rich forms

export interface FormKindSpec {
  purpose?: string;
  form: FormSpec;
  /** The consequential choices to call out in the review summary. */
  reviewNote?: string;
}

export interface FormKindResult {
  schemaRevision: number;
  values: FormValues;
}

export const formKind: RichKindModule<FormKindSpec, FormKindResult> = {
  kind: "form",
  features: [2],
  title: "Form",
  actions: [followup("submit", "Submit")],
  customFollowups: false,
  repeatable: false,
  readSpec(value, path) {
    const record = obj(value, path, ["purpose", "form", "reviewNote"]);
    const purpose = optStr(record.purpose, `${path}.purpose`, TEXT);
    const reviewNote = optStr(record.reviewNote, `${path}.reviewNote`, TEXT);
    return {
      form: readFormSpec(record.form, `${path}.form`),
      ...(purpose === undefined ? {} : { purpose }),
      ...(reviewNote === undefined ? {} : { reviewNote }),
    };
  },
  readResult(spec, _action, value, path) {
    const record = obj(value, path, ["schemaRevision", "values"]);
    return {
      schemaRevision: num(record.schemaRevision, `${path}.schemaRevision`, {
        min: 0,
        integer: true,
      }),
      values: readFormValues(spec.form, record.values, `${path}.values`),
    };
  },
  summarize(spec, _action, result) {
    return ["Submitted values:", ...summarizeFormValues(spec.form.fields, result.values)];
  },
  fallback(spec) {
    return `${spec.purpose ?? "Please provide:"}\n${spec.form.fields.map((f) => `- ${f.label}${f.required ? " (required)" : ""}`).join("\n")}`;
  },
};

// ---------------------------------------------------------------------------
// 03. Editable implementation plans

export interface PlanStep {
  id: string;
  title: string;
  description?: string;
  rationale?: string;
  included: boolean;
  optional?: boolean;
  dependsOn: string[];
  status?: "pending" | "running" | "done" | "skipped";
  comments?: Array<{ id: string; author: "user" | "agent"; text: string }>;
}

export interface PlanSpec {
  planId: string;
  steps: PlanStep[];
  constraints: Array<{ id: string; text: string; author: "user" | "agent" }>;
  criteria: Array<{ id: string; text: string }>;
  /** Set when work is under way: scope edits become a pending amendment. */
  executing?: boolean;
}

export type PlanChange =
  | { op: "setIncluded"; stepId: string; value: boolean }
  | { op: "moveBefore"; stepId: string; beforeStepId: string | null }
  | { op: "editStep"; stepId: string; title?: string; description?: string }
  | { op: "addComment"; stepId: string; text: string }
  | { op: "addConstraint"; text: string }
  | { op: "removeConstraint"; constraintId: string }
  | { op: "editCriterion"; criterionId: string; text: string }
  | { op: "addCriterion"; text: string };

export interface PlanResult {
  baseRevision: number;
  changes: PlanChange[];
  comment?: string;
}

function readPlanStep(value: unknown, path: string): PlanStep {
  const record = obj(value, path, [
    "id",
    "title",
    "description",
    "rationale",
    "included",
    "optional",
    "dependsOn",
    "status",
    "comments",
  ]);
  const description = optStr(record.description, `${path}.description`, TEXT);
  const rationale = optStr(record.rationale, `${path}.rationale`, TEXT);
  const optional = optBool(record.optional, `${path}.optional`);
  const status =
    record.status === undefined
      ? undefined
      : oneOf(record.status, `${path}.status`, ["pending", "running", "done", "skipped"] as const);
  const comments = optArr(record.comments, `${path}.comments`, 50, (c, p) => {
    const comment = obj(c, p, ["id", "author", "text"]);
    return {
      id: id(comment.id, `${p}.id`),
      author: oneOf(comment.author, `${p}.author`, ["user", "agent"] as const),
      text: str(comment.text, `${p}.text`, TEXT, 1),
    };
  });
  return {
    id: id(record.id, `${path}.id`, 64),
    title: str(record.title, `${path}.title`, LABEL, 1),
    included: record.included === undefined ? true : bool(record.included, `${path}.included`),
    dependsOn: optArr(record.dependsOn, `${path}.dependsOn`, 50, (d, p) => id(d, p, 64)) ?? [],
    ...(description === undefined ? {} : { description }),
    ...(rationale === undefined ? {} : { rationale }),
    ...(optional === undefined ? {} : { optional }),
    ...(status === undefined ? {} : { status }),
    ...(comments === undefined ? {} : { comments }),
  };
}

/** Steps whose dependencies form a cycle, or null. */
export function planCycle(steps: readonly PlanStep[]): string[] | null {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (stepId: string): string[] | null => {
    if (state.get(stepId) === "done") return null;
    if (state.get(stepId) === "visiting") return [...stack.slice(stack.indexOf(stepId)), stepId];
    state.set(stepId, "visiting");
    stack.push(stepId);
    for (const dependency of byId.get(stepId)?.dependsOn ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(stepId, "done");
    return null;
  };
  for (const step of steps) {
    const cycle = visit(step.id);
    if (cycle) return cycle;
  }
  return null;
}

/** Included steps that depend on an excluded step, with the excluded prerequisite. */
export function planDependencyProblems(
  steps: readonly PlanStep[],
): Array<{ stepId: string; missing: string }> {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const problems: Array<{ stepId: string; missing: string }> = [];
  for (const step of steps) {
    if (!step.included) continue;
    for (const dependency of step.dependsOn) {
      if (byId.get(dependency)?.included === false)
        problems.push({ stepId: step.id, missing: dependency });
    }
  }
  return problems;
}

function readPlanChange(spec: PlanSpec, value: unknown, path: string): PlanChange {
  const record = obj(value, path, [
    "op",
    "stepId",
    "value",
    "beforeStepId",
    "title",
    "description",
    "text",
    "constraintId",
    "criterionId",
  ]);
  const op = oneOf(record.op, `${path}.op`, [
    "setIncluded",
    "moveBefore",
    "editStep",
    "addComment",
    "addConstraint",
    "removeConstraint",
    "editCriterion",
    "addCriterion",
  ] as const);
  const step = () => {
    const stepId = id(record.stepId, `${path}.stepId`, 64);
    if (!spec.steps.some((s) => s.id === stepId))
      fail(`${path}.stepId`, "is not a step of this plan revision");
    return stepId;
  };
  switch (op) {
    case "setIncluded":
      return { op, stepId: step(), value: bool(record.value, `${path}.value`) };
    case "moveBefore": {
      const stepId = step();
      if (record.beforeStepId === null) return { op, stepId, beforeStepId: null };
      const beforeStepId = id(record.beforeStepId, `${path}.beforeStepId`, 64);
      if (!spec.steps.some((s) => s.id === beforeStepId))
        fail(`${path}.beforeStepId`, "is not a step of this plan revision");
      if (beforeStepId === stepId) fail(`${path}.beforeStepId`, "must differ from the moved step");
      return { op, stepId, beforeStepId };
    }
    case "editStep": {
      const title = optStr(record.title, `${path}.title`, LABEL);
      const description = optStr(record.description, `${path}.description`, TEXT);
      if (title === undefined && description === undefined) fail(path, "changes nothing");
      if (title !== undefined && !title.trim()) fail(`${path}.title`, "must not be empty");
      return {
        op,
        stepId: step(),
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
      };
    }
    case "addComment":
      return { op, stepId: step(), text: str(record.text, `${path}.text`, TEXT, 1) };
    case "addConstraint":
      return { op, text: str(record.text, `${path}.text`, TEXT, 1) };
    case "removeConstraint": {
      const constraintId = id(record.constraintId, `${path}.constraintId`);
      if (!spec.constraints.some((c) => c.id === constraintId))
        fail(`${path}.constraintId`, "is not a constraint of this plan");
      return { op, constraintId };
    }
    case "editCriterion": {
      const criterionId = id(record.criterionId, `${path}.criterionId`);
      if (!spec.criteria.some((c) => c.id === criterionId))
        fail(`${path}.criterionId`, "is not a criterion of this plan");
      return { op, criterionId, text: str(record.text, `${path}.text`, TEXT, 1) };
    }
    case "addCriterion":
      return { op, text: str(record.text, `${path}.text`, TEXT, 1) };
  }
}

/** Applies a change set to a plan; ids for new items derive from their position in the change set. */
export function applyPlanChanges(spec: PlanSpec, changes: readonly PlanChange[]): PlanSpec {
  let steps = spec.steps.map((step) => ({
    ...step,
    dependsOn: [...step.dependsOn],
    comments: [...(step.comments ?? [])],
  }));
  let constraints = [...spec.constraints];
  let criteria = [...spec.criteria];
  changes.forEach((change, index) => {
    switch (change.op) {
      case "setIncluded":
        steps = steps.map((step) =>
          step.id === change.stepId ? { ...step, included: change.value } : step,
        );
        break;
      case "moveBefore": {
        const moved = steps.find((step) => step.id === change.stepId)!;
        const rest = steps.filter((step) => step.id !== change.stepId);
        const at =
          change.beforeStepId === null
            ? rest.length
            : rest.findIndex((step) => step.id === change.beforeStepId);
        rest.splice(at < 0 ? rest.length : at, 0, moved);
        steps = rest;
        break;
      }
      case "editStep":
        steps = steps.map((step) =>
          step.id === change.stepId
            ? {
                ...step,
                ...(change.title === undefined ? {} : { title: change.title }),
                ...(change.description === undefined ? {} : { description: change.description }),
              }
            : step,
        );
        break;
      case "addComment":
        steps = steps.map((step) =>
          step.id === change.stepId
            ? {
                ...step,
                comments: [
                  ...step.comments,
                  {
                    id: `c${spec.steps.length}-${index}-${step.comments.length}`,
                    author: "user" as const,
                    text: change.text,
                  },
                ],
              }
            : step,
        );
        break;
      case "addConstraint":
        constraints = [
          ...constraints,
          {
            id: `user-constraint-${constraints.length + 1}-${index}`,
            text: change.text,
            author: "user",
          },
        ];
        break;
      case "removeConstraint":
        constraints = constraints.filter((c) => c.id !== change.constraintId);
        break;
      case "editCriterion":
        criteria = criteria.map((c) =>
          c.id === change.criterionId ? { ...c, text: change.text } : c,
        );
        break;
      case "addCriterion":
        criteria = [
          ...criteria,
          { id: `user-criterion-${criteria.length + 1}-${index}`, text: change.text },
        ];
        break;
    }
  });
  return {
    ...spec,
    steps: steps.map(({ comments, ...step }) => (comments.length ? { ...step, comments } : step)),
    constraints,
    criteria,
  };
}

function describePlanChange(spec: PlanSpec, change: PlanChange): string {
  const step = (stepId: string) => {
    const found = spec.steps.find((s) => s.id === stepId);
    return found ? `"${found.title}" [${stepId}]` : `[${stepId}]`;
  };
  switch (change.op) {
    case "setIncluded":
      return `${change.value ? "include" : "exclude (defer)"} step ${step(change.stepId)}`;
    case "moveBefore":
      return `move step ${step(change.stepId)} ${change.beforeStepId === null ? "to the end" : `before ${step(change.beforeStepId)}`}`;
    case "editStep":
      return `edit step ${step(change.stepId)}${change.title !== undefined ? ` title → ${JSON.stringify(change.title)}` : ""}${change.description !== undefined ? ` description → ${JSON.stringify(clip(change.description, 400))}` : ""}`;
    case "addComment":
      return `comment on step ${step(change.stepId)}: ${JSON.stringify(change.text)}`;
    case "addConstraint":
      return `add constraint: ${JSON.stringify(change.text)}`;
    case "removeConstraint":
      return `remove constraint [${change.constraintId}]`;
    case "editCriterion":
      return `edit acceptance criterion [${change.criterionId}] → ${JSON.stringify(change.text)}`;
    case "addCriterion":
      return `add acceptance criterion: ${JSON.stringify(change.text)}`;
  }
}

export const planKind: RichKindModule<PlanSpec, PlanResult> = {
  kind: "plan",
  features: [3],
  title: "Implementation plan",
  actions: [
    followup("request-revision", "Submit revised plan", { closesRequest: false }),
    followup("accept-scope", "Agree to selected scope", {
      description:
        "Records the exact revision and included steps you agree to. It does not grant command or file permissions.",
    }),
    revise("save", "Save edits"),
  ],
  customFollowups: false,
  repeatable: true,
  readSpec(value, path) {
    const record = obj(value, path, ["planId", "steps", "constraints", "criteria", "executing"]);
    const steps = arr(record.steps, `${path}.steps`, 100, readPlanStep, 1);
    uniqueIds(steps, `${path}.steps`, (s) => s.id);
    for (const [index, step] of steps.entries()) {
      for (const dependency of step.dependsOn) {
        if (!steps.some((s) => s.id === dependency))
          fail(`${path}.steps[${index}].dependsOn`, `names unknown step ${dependency}`);
      }
    }
    const cycle = planCycle(steps);
    if (cycle) fail(`${path}.steps`, `dependencies form a cycle: ${cycle.join(" → ")}`);
    const constraints =
      optArr(record.constraints, `${path}.constraints`, 50, (c, p) => {
        const item = obj(c, p, ["id", "text", "author"]);
        return {
          id: id(item.id, `${p}.id`),
          text: str(item.text, `${p}.text`, TEXT, 1),
          author:
            item.author === undefined
              ? ("agent" as const)
              : oneOf(item.author, `${p}.author`, ["user", "agent"] as const),
        };
      }) ?? [];
    uniqueIds(constraints, `${path}.constraints`, (c) => c.id);
    const criteria =
      optArr(record.criteria, `${path}.criteria`, 50, (c, p) => {
        const item = obj(c, p, ["id", "text"]);
        return { id: id(item.id, `${p}.id`), text: str(item.text, `${p}.text`, TEXT, 1) };
      }) ?? [];
    uniqueIds(criteria, `${path}.criteria`, (c) => c.id);
    const executing = optBool(record.executing, `${path}.executing`);
    return {
      planId: id(record.planId, `${path}.planId`),
      steps,
      constraints,
      criteria,
      ...(executing === undefined ? {} : { executing }),
    };
  },
  readResult(spec, action, value, path) {
    const record = obj(value, path, ["baseRevision", "changes", "comment"]);
    const changes = arr(record.changes, `${path}.changes`, 200, (c, p) =>
      readPlanChange(spec, c, p),
    );
    const comment = optStr(record.comment, `${path}.comment`, TEXT);
    const result = {
      baseRevision: num(record.baseRevision, `${path}.baseRevision`, { min: 0, integer: true }),
      changes,
      ...(comment?.trim() ? { comment: comment.trim() } : {}),
    };
    const next = applyPlanChanges(spec, changes);
    const cycle = planCycle(next.steps);
    if (cycle) fail(`${path}.changes`, `the result has a dependency cycle: ${cycle.join(" → ")}`);
    if (action.id === "accept-scope") {
      const problems = planDependencyProblems(next.steps);
      if (problems.length) {
        const first = problems[0]!;
        fail(
          `${path}.changes`,
          `step ${first.stepId} depends on excluded step ${first.missing}; include it or exclude the dependent step`,
        );
      }
      if (!next.steps.some((step) => step.included))
        fail(`${path}.changes`, "the agreed scope includes no step");
    }
    if (action.id !== "accept-scope" && changes.length === 0 && !result.comment)
      fail(`${path}.changes`, "changes nothing");
    return result;
  },
  applyRevision(spec, result, action) {
    return action.id === "save" ? applyPlanChanges(spec, result.changes) : null;
  },
  summarize(spec, action, result) {
    const next = applyPlanChanges(spec, result.changes);
    const lines = result.changes.map((change) => `- ${describePlanChange(spec, change)}`);
    if (action.id === "accept-scope") {
      lines.unshift(
        `The user agreed to this scope of plan ${spec.planId} (base revision ${result.baseRevision}). Agreement does not grant command, file or merge permissions.`,
      );
      lines.push("Included steps, in order:");
      next.steps
        .filter((s) => s.included)
        .forEach((s, i) => lines.push(`  ${i + 1}. ${s.title} [${s.id}]`));
      const deferred = next.steps.filter((s) => !s.included);
      if (deferred.length)
        lines.push(`Deferred steps: ${deferred.map((s) => `${s.title} [${s.id}]`).join(", ")}`);
      if (spec.executing)
        lines.push(
          "Work is under way: treat this as a pending amendment, not a rewrite of work already done.",
        );
    } else {
      lines.unshift(
        `The user revised plan ${spec.planId} (base revision ${result.baseRevision}) and asks for a revised plan addressing these changes:`,
      );
    }
    if (result.comment) lines.push(`User comment: ${JSON.stringify(result.comment)}`);
    return lines;
  },
  fallback(spec) {
    return spec.steps
      .map((s, i) => `${i + 1}. ${s.included ? "" : "(deferred) "}${s.title}`)
      .join("\n");
  },
};

// ---------------------------------------------------------------------------
// 04. Selectable tables with actions

export const COLLECTION_COLUMN_TYPES = [
  "text",
  "number",
  "boolean",
  "datetime",
  "enum",
  "ref",
] as const;
export type CollectionColumnType = (typeof COLLECTION_COLUMN_TYPES)[number];
export type CollectionCell = string | number | boolean | null;

export interface CollectionColumn {
  id: string;
  label: string;
  type: CollectionColumnType;
  unit?: string;
  options?: string[];
  editable?: boolean;
}

export interface CollectionSpec {
  collectionId: string;
  sourceRevision: number;
  columns: CollectionColumn[];
  rows: Array<{ id: string; cells: Record<string, CollectionCell> }>;
  /** False when `rows` is a page of a larger set: select-all-records is then refused. */
  complete: boolean;
  totalRows?: number;
  maxSelection?: number;
}

export interface CollectionResult {
  sourceRevision: number;
  selection: { mode: "explicit"; rowIds: string[] } | { mode: "all-records" };
  edits: Array<{ rowId: string; field: string; value: CollectionCell }>;
  /** Only when the user explicitly submits a ranking. */
  rankedRowIds?: string[];
  note?: string;
}

export const COLLECTION_LIMITS = {
  rows: 2_000,
  columns: 30,
  selection: 2_000,
  cellChars: 2_000,
} as const;

function readCell(column: CollectionColumn, value: unknown, path: string): CollectionCell {
  if (value === null) return null;
  switch (column.type) {
    case "number":
      return num(value, path);
    case "boolean":
      return bool(value, path);
    case "datetime": {
      const text = str(value, path, 64);
      if (Number.isNaN(Date.parse(text))) fail(path, "must be an ISO-8601 date/time");
      return text;
    }
    case "enum": {
      const text = str(value, path, LABEL);
      if (column.options && !column.options.includes(text))
        fail(path, "is not one of the column's values");
      return text;
    }
    default:
      return str(value, path, COLLECTION_LIMITS.cellChars);
  }
}

/** Declared comparison for sorting: numbers numerically, dates by instant, text by locale, nulls last. */
export function compareCollectionCells(
  type: CollectionColumnType,
  left: CollectionCell,
  right: CollectionCell,
): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  if (type === "number") return Number(left) - Number(right);
  if (type === "boolean") return Number(left) - Number(right);
  if (type === "datetime") return Date.parse(String(left)) - Date.parse(String(right));
  return String(left).localeCompare(String(right), undefined, {
    numeric: false,
    sensitivity: "base",
  });
}

export const collectionKind: RichKindModule<CollectionSpec, CollectionResult> = {
  kind: "collection",
  features: [4],
  title: "Selectable collection",
  actions: [followup("discuss-selected", "Discuss selected rows")],
  customFollowups: true,
  repeatable: true,
  readSpec(value, path) {
    const record = obj(value, path, [
      "collectionId",
      "sourceRevision",
      "columns",
      "rows",
      "complete",
      "totalRows",
      "maxSelection",
    ]);
    const columns = arr(
      record.columns,
      `${path}.columns`,
      COLLECTION_LIMITS.columns,
      (c, p) => {
        const column = obj(c, p, ["id", "label", "type", "unit", "options", "editable"]);
        const type = oneOf(column.type, `${p}.type`, COLLECTION_COLUMN_TYPES);
        const unit = optStr(column.unit, `${p}.unit`, 40);
        const options = optArr(column.options, `${p}.options`, 100, (o, op) =>
          str(o, op, LABEL, 1),
        );
        if (options && type !== "enum") fail(`${p}.options`, "only enum columns declare options");
        const editable = optBool(column.editable, `${p}.editable`);
        return {
          id: id(column.id, `${p}.id`, 64),
          label: str(column.label, `${p}.label`, LABEL, 1),
          type,
          ...(unit === undefined ? {} : { unit }),
          ...(options === undefined ? {} : { options }),
          ...(editable === undefined ? {} : { editable }),
        };
      },
      1,
    );
    uniqueIds(columns, `${path}.columns`, (c) => c.id);
    const rows = arr(record.rows, `${path}.rows`, COLLECTION_LIMITS.rows, (r, p) => {
      const row = obj(r, p, ["id", "cells"]);
      if (!isRecord(row.cells)) fail(`${p}.cells`, "must be an object keyed by column id");
      const cells: Record<string, CollectionCell> = {};
      for (const [key, cell] of Object.entries(row.cells)) {
        const column = columns.find((c) => c.id === key);
        if (!column) fail(`${p}.cells.${key}`, "is not a declared column");
        cells[key] = readCell(column, cell, `${p}.cells.${key}`);
      }
      return { id: id(row.id, `${p}.id`), cells };
    });
    uniqueIds(rows, `${path}.rows`, (r) => r.id);
    const complete = bool(record.complete, `${path}.complete`);
    const totalRows = optNum(record.totalRows, `${path}.totalRows`, {
      min: rows.length,
      integer: true,
    });
    if (complete && totalRows !== undefined && totalRows !== rows.length)
      fail(`${path}.totalRows`, "a complete collection's total equals its rows");
    const maxSelection = optNum(record.maxSelection, `${path}.maxSelection`, {
      min: 1,
      max: COLLECTION_LIMITS.selection,
      integer: true,
    });
    return {
      collectionId: id(record.collectionId, `${path}.collectionId`),
      sourceRevision: num(record.sourceRevision, `${path}.sourceRevision`, {
        min: 0,
        integer: true,
      }),
      columns,
      rows,
      complete,
      ...(totalRows === undefined ? {} : { totalRows }),
      ...(maxSelection === undefined ? {} : { maxSelection }),
    };
  },
  readResult(spec, _action, value, path) {
    const record = obj(value, path, [
      "sourceRevision",
      "selection",
      "edits",
      "rankedRowIds",
      "note",
    ]);
    const sourceRevision = num(record.sourceRevision, `${path}.sourceRevision`, {
      min: 0,
      integer: true,
    });
    if (sourceRevision !== spec.sourceRevision)
      fail(
        `${path}.sourceRevision`,
        `the collection is now at revision ${spec.sourceRevision}; review the changed rows and resubmit`,
      );
    const selectionRecord = obj(record.selection, `${path}.selection`, ["mode", "rowIds"]);
    const mode = oneOf(selectionRecord.mode, `${path}.selection.mode`, [
      "explicit",
      "all-records",
    ] as const);
    const rowIdSet = new Set(spec.rows.map((row) => row.id));
    let selection: CollectionResult["selection"];
    if (mode === "all-records") {
      if (!spec.complete)
        fail(
          `${path}.selection.mode`,
          "this collection is partial: unseen records cannot be selected; select explicit rows",
        );
      selection = { mode };
    } else {
      const rowIds = arr(
        selectionRecord.rowIds,
        `${path}.selection.rowIds`,
        spec.maxSelection ?? COLLECTION_LIMITS.selection,
        (r, p) => {
          const rowId = id(r, p);
          if (!rowIdSet.has(rowId)) fail(p, "is not a row of this collection revision");
          return rowId;
        },
        1,
      );
      if (new Set(rowIds).size !== rowIds.length)
        fail(`${path}.selection.rowIds`, "must not repeat a row");
      selection = { mode, rowIds };
    }
    const edits =
      optArr(record.edits, `${path}.edits`, 500, (e, p) => {
        const edit = obj(e, p, ["rowId", "field", "value"]);
        const rowId = id(edit.rowId, `${p}.rowId`);
        if (!rowIdSet.has(rowId)) fail(`${p}.rowId`, "is not a row of this collection revision");
        const field = id(edit.field, `${p}.field`, 64);
        const column = spec.columns.find((c) => c.id === field);
        if (!column?.editable) fail(`${p}.field`, "is not an editable column");
        return { rowId, field, value: readCell(column, edit.value, `${p}.value`) };
      }) ?? [];
    const rankedRowIds = optArr(
      record.rankedRowIds,
      `${path}.rankedRowIds`,
      COLLECTION_LIMITS.selection,
      (r, p) => {
        const rowId = id(r, p);
        if (!rowIdSet.has(rowId)) fail(p, "is not a row of this collection revision");
        return rowId;
      },
    );
    const note = optStr(record.note, `${path}.note`, TEXT);
    return {
      sourceRevision,
      selection,
      edits,
      ...(rankedRowIds ? { rankedRowIds } : {}),
      ...(note?.trim() ? { note: note.trim() } : {}),
    };
  },
  summarize(spec, action, result) {
    const lines = [
      `Requested action: ${action.label} [${action.id}] on collection ${spec.collectionId} (revision ${spec.sourceRevision}).`,
    ];
    const titleColumn = spec.columns.find((c) => c.type === "text") ?? spec.columns[0]!;
    const describe = (rowId: string) => {
      const row = spec.rows.find((r) => r.id === rowId);
      const title = row?.cells[titleColumn.id];
      return `${rowId}${title === undefined || title === null ? "" : ` (${clip(String(title), 120)})`}`;
    };
    if (result.selection.mode === "all-records") {
      lines.push(`Selection: all ${spec.rows.length} records of this complete collection.`);
    } else {
      const shown = result.selection.rowIds.slice(0, 200);
      lines.push(`Selected ${result.selection.rowIds.length} row(s):`);
      shown.forEach((rowId) => lines.push(`  - ${describe(rowId)}`));
      if (result.selection.rowIds.length > shown.length)
        lines.push(
          `  … ${result.selection.rowIds.length - shown.length} more selected rows omitted here; read the interaction result for the full list.`,
        );
    }
    if (result.edits.length) {
      lines.push("Proposed edits (not applied to the source):");
      result.edits.forEach((e) =>
        lines.push(`  - ${e.rowId}.${e.field} → ${JSON.stringify(e.value)}`),
      );
    }
    if (result.rankedRowIds) lines.push(`User ranking: ${result.rankedRowIds.join(" > ")}`);
    if (result.note) lines.push(`User note: ${JSON.stringify(result.note)}`);
    return lines;
  },
  fallback(spec) {
    return `${spec.rows.length} rows${spec.complete ? "" : ` of ${spec.totalRows ?? "more"}`}: ${spec.columns.map((c) => c.label).join(" | ")}`;
  },
};
