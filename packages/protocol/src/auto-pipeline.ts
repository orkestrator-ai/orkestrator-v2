import * as Schema from "effect/Schema";
import type { KeyInformationPatch } from "./build-pipeline-key-information.js";
import { asModel } from "./contract/model-schema.js";

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
