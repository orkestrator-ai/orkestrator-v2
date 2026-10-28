import { z } from "zod";
import {
  DELIVERY_POLICIES,
  TICKET_KIND_GUIDANCE,
  TICKET_KINDS,
  TICKET_SECTION_LIMITS,
  TICKET_SECTIONS_GUIDANCE,
  ticketCriteriaSummary,
  type TicketSections,
} from "@orkestrator/protocol/ticket-sections";

/*
 * The ticket `kind` and `sections` fields shared by the worker agent tools and
 * the coordinator Control MCP. Values are checked again by
 * `parseTicketSectionsPatch` wherever they reach storage.
 */

const MAX_SECTION_TEXT = 100_000;
const sectionText = z.string().max(MAX_SECTION_TEXT).optional();

export const ticketKindField = z.enum(TICKET_KINDS).optional().describe(TICKET_KIND_GUIDANCE);

export const ticketSectionsField = z
  .object({
    summary: sectionText,
    problem: sectionText,
    context: sectionText,
    decisions: sectionText,
    constraints: sectionText,
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(TICKET_SECTION_LIMITS.maxCriterionLength))
      .max(TICKET_SECTION_LIMITS.maxAcceptanceCriteria)
      .optional(),
    checks: z
      .array(z.string().trim().min(1).max(TICKET_SECTION_LIMITS.maxCheckLength))
      .max(TICKET_SECTION_LIMITS.maxChecks)
      .optional(),
    delivery: z
      .object({
        policy: z.enum(DELIVERY_POLICIES).optional(),
        note: z.string().max(MAX_SECTION_TEXT).optional(),
      })
      .strict()
      .optional(),
    reporting: sectionText,
    outOfScope: sectionText,
    custom: z
      .array(
        z
          .object({
            title: z
              .string()
              .trim()
              .min(1)
              .max(TICKET_SECTION_LIMITS.maxCustomTitleLength)
              .regex(/^[^\n]*$/, "Section titles are one line"),
            body: z.string().max(MAX_SECTION_TEXT),
          })
          .strict(),
      )
      .max(TICKET_SECTION_LIMITS.maxCustomSections)
      .optional(),
    notes: sectionText,
  })
  .strict()
  .optional()
  .describe(TICKET_SECTIONS_GUIDANCE);

export type TicketSectionsFieldValue = z.infer<typeof ticketSectionsField>;

/** Each criterion's text in tool output; the full text is in `acceptanceCriteria`. */
const MAX_CRITERION_OUTPUT_CHARS = 500;
/** The whole `criteria` list in tool output. */
const MAX_CRITERIA_OUTPUT_BYTES = 32 * 1024;

/**
 * The structured part of a ticket in tool output. The text mirrors carry the
 * full content, so each criterion is a short handle (id, result, the start of
 * its text) and the list is bounded.
 */
export function ticketStructuredOutput(task: {
  kind?: unknown;
  sections?: TicketSections;
}): Record<string, unknown> {
  const criteria: Array<Record<string, unknown>> = [];
  let bytes = 2;
  let truncated = false;
  for (const criterion of ticketCriteriaSummary(task.sections)) {
    const entry = {
      ...criterion,
      text: criterion.text.slice(0, MAX_CRITERION_OUTPUT_CHARS),
      ...(criterion.text.length > MAX_CRITERION_OUTPUT_CHARS ? { textTruncated: true } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (bytes + size > MAX_CRITERIA_OUTPUT_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    criteria.push(entry);
  }
  const policy = task.sections?.delivery?.policy;
  return {
    kind: typeof task.kind === "string" ? task.kind : "feature",
    ...(criteria.length ? { criteria } : {}),
    ...(truncated ? { criteriaTruncated: true } : {}),
    ...(policy ? { deliveryPolicy: policy } : {}),
  };
}
