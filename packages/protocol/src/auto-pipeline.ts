import * as Schema from "effect/Schema";
import type { KeyInformationPatch } from "./build-pipeline-key-information.js";
import { asModel } from "./contract/model-schema.js";
import { AUTO_PIPELINE_TOOL_NAME } from "./auto-pipeline-tool.js";
import { ACCEPTANCE_CRITERIA_RULE } from "./ticket-sections.js";

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000));
const texts = Schema.Array(text).check(Schema.isMaxLength(100));
export const AutoPipelineTicketSchema = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  description: text,
  acceptanceCriteria: texts.check(Schema.isMinLength(1)),
});
export type AutoPipelineTicket = Schema.Schema.Type<typeof AutoPipelineTicketSchema>;
const notesSchema = Schema.Struct({
  summary: text,
  workDone: texts,
  decisions: Schema.Array(
    Schema.Struct({
      decision: text,
      chosen: text,
      rationale: Schema.optional(text),
      options: Schema.Array(Schema.Struct({ option: text, pros: texts, cons: texts })).check(
        Schema.isMaxLength(20),
      ),
    }),
  ).check(Schema.isMaxLength(100)),
  tests: Schema.Array(
    Schema.Struct({
      name: text,
      result: Schema.Literals(["passed", "failed", "skipped", "not-run"]),
      details: Schema.optional(text),
    }),
  ).check(Schema.isMaxLength(100)),
  notDone: texts,
});
export interface AutoPipelineDraft extends AutoPipelineTicket {
  id: string;
  notes: KeyInformationPatch;
  uncommittedFiles: string[];
}
export interface AutoPipelineSource {
  tabId: string;
  label: string;
  disabledReason?: string;
}
export interface AutoPipelineSources {
  available: boolean;
  sources: AutoPipelineSource[];
}
export const AutoPipelineDraftSchema = asModel<AutoPipelineDraft>(
  Schema.Struct({
    ...AutoPipelineTicketSchema.fields,
    id: text,
    notes: notesSchema,
    uncommittedFiles: Schema.Array(text).check(Schema.isMaxLength(1000)),
  }),
);
/** Unsaved-ticket edits: every field may be blank or partial while the user types. */
export const AutoPipelineEditsSchema = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(240)),
  description: Schema.String.check(Schema.isMaxLength(32000)),
  acceptanceCriteria: Schema.Array(Schema.String.check(Schema.isMaxLength(32000))).check(
    Schema.isMaxLength(100),
  ),
});
export type AutoPipelineEdits = Schema.Schema.Type<typeof AutoPipelineEditsSchema>;
/**
 * Where an environment tab's Auto-pipeline draft stands, read by the
 * `auto-pipeline` tab whenever it mounts. Drafting and promotion run in the
 * backend, so leaving the tab neither cancels nor loses them. `edits` are the
 * user's saved changes to the generated ticket fields. `reviewed` is the ticket
 * a confirmation was already submitted with: once set the draft is locked, and
 * only confirming that same ticket again (or drafting again) can proceed.
 */
export type AutoPipelineState =
  | { phase: "idle" }
  | { phase: "drafting" }
  | { phase: "failed"; error: string }
  | {
      phase: "ready";
      draft: AutoPipelineDraft;
      edits?: AutoPipelineEdits;
      reviewed?: AutoPipelineTicket;
      confirmError?: string;
    }
  | {
      phase: "promoting";
      draft: AutoPipelineDraft;
      edits?: AutoPipelineEdits;
      reviewed?: AutoPipelineTicket;
    }
  | { phase: "promoted"; pipelineId: string };
export const AutoPipelineStateSchema = asModel<AutoPipelineState>(
  Schema.Union([
    Schema.Struct({ phase: Schema.Literal("idle") }),
    Schema.Struct({ phase: Schema.Literal("drafting") }),
    Schema.Struct({ phase: Schema.Literal("failed"), error: text }),
    Schema.Struct({
      phase: Schema.Literal("ready"),
      draft: AutoPipelineDraftSchema,
      edits: Schema.optional(AutoPipelineEditsSchema),
      reviewed: Schema.optional(AutoPipelineTicketSchema),
      confirmError: Schema.optional(text),
    }),
    Schema.Struct({
      phase: Schema.Literal("promoting"),
      draft: AutoPipelineDraftSchema,
      edits: Schema.optional(AutoPipelineEditsSchema),
      reviewed: Schema.optional(AutoPipelineTicketSchema),
    }),
    Schema.Struct({ phase: Schema.Literal("promoted"), pipelineId: text }),
  ]),
);
export const AutoPipelineSourcesSchema = asModel<AutoPipelineSources>(
  Schema.Struct({
    available: Schema.Boolean,
    sources: Schema.Array(
      Schema.Struct({ tabId: text, label: text, disabledReason: Schema.optional(text) }),
    ).check(Schema.isMaxLength(100)),
  }),
);
const stringSchema = { type: "string", minLength: 1, maxLength: 32000 };
const stringsSchema = { type: "array", maxItems: 100, items: stringSchema };
export const autoPipelineResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "description", "acceptanceCriteria", "notes"],
  properties: {
    title: { ...stringSchema, maxLength: 240 },
    description: stringSchema,
    acceptanceCriteria: { ...stringsSchema, minItems: 1 },
    notes: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "workDone", "decisions", "tests", "notDone"],
      properties: {
        summary: stringSchema,
        workDone: stringsSchema,
        notDone: stringsSchema,
        decisions: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["decision", "chosen", "options"],
            properties: {
              decision: stringSchema,
              chosen: stringSchema,
              rationale: stringSchema,
              options: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["option", "pros", "cons"],
                  properties: { option: stringSchema, pros: stringsSchema, cons: stringsSchema },
                },
              },
            },
          },
        },
        tests: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "result"],
            properties: {
              name: stringSchema,
              result: { type: "string", enum: ["passed", "failed", "skipped", "not-run"] },
              details: stringSchema,
            },
          },
        },
      },
    },
  },
};
/**
 * The Orkestrator MCP tool an interactive agent tab calls to hand its work to
 * Auto-pipeline. It is offered to every interactive tab in a prompt
 * environment, so asking for a pipeline in plain chat works the same as the
 * toolbar button, which only sends {@link autoPipelineDraftPrompt}.
 */
export { AUTO_PIPELINE_TOOL_NAME } from "./auto-pipeline-tool.js";

/**
 * What the "To pipeline" button sends to the tab. The agent writes the draft
 * from its own record of the session and from the repository, so nothing is
 * copied into a prompt and the draft cannot outgrow one.
 */
export function autoPipelineDraftPrompt(): string {
  return [
    `Convert this conversation and the work in this environment into a pipeline draft for review. Call the Orkestrator tool \`${AUTO_PIPELINE_TOOL_NAME}\` once with:`,
    "- title: one line.",
    "- description: Summary, Problem and Context sections.",
    `- acceptanceCriteria: each one line and independently checkable. ${ACCEPTANCE_CRITERIA_RULE}`,
    "- notes: only what you observed. Record decisions as a concise engineering summary (the choice, the options with their pros and cons, and the justification from requirements, code or test results), the files you touched, the checks you ran with their results, and any unfinished work. Do not reconstruct private reasoning or invent alternatives.",
    "Work from your own record of this session and from the repository: read `git status`, `git diff` and `git log` rather than relying on memory for what changed. Do not edit files, commit or send messages. When the tool accepts the draft, say that it is ready to review in the Auto-pipeline tab and stop.",
  ].join("\n");
}
export function parseAutoPipelineTicket(value: unknown): AutoPipelineTicket {
  const ticket = Schema.decodeUnknownSync(AutoPipelineTicketSchema)(value);
  if (
    ![ticket.title, ticket.description, ...ticket.acceptanceCriteria].every(
      (text) => text.trim().length,
    )
  )
    throw new Error("Ticket fields cannot be blank");
  if ([ticket.title, ...ticket.acceptanceCriteria].some((text) => /[\r\n]/.test(text)))
    throw new Error("Title and acceptance criteria must be single lines");
  const sections = Array.from(
    ticket.description.matchAll(
      /^[ \t]*(?:#{1,6}[ \t]+)?(Summary|Problem|Context)[ \t]*(?::[ \t]*|\r?$)/gim,
    ),
  );
  for (const section of ["Summary", "Problem", "Context"]) {
    const index = sections.findIndex((match) => match[1]?.toLowerCase() === section.toLowerCase());
    const match = sections[index];
    const body = match
      ? ticket.description.slice(match.index! + match[0].length, sections[index + 1]?.index)
      : "";
    if (!body.trim()) throw new Error(`Ticket description requires a nonempty ${section} section`);
  }
  return ticket;
}
export function parseAutoPipelineResult(
  value: unknown,
): AutoPipelineTicket & { notes: KeyInformationPatch } {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024)
    throw new Error("Auto-pipeline result exceeds its size limit");
  const ticket = parseAutoPipelineTicket(value);
  const notes = Schema.decodeUnknownSync(notesSchema)((value as { notes?: unknown }).notes);
  return { ...ticket, notes: structuredClone(notes) as KeyInformationPatch };
}
