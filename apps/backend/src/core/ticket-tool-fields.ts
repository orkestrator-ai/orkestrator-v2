import { Schema } from "effect";
import { describe, list, str, strictObject, type Infer } from "./tool-schema.js";
import {
  TICKET_LABEL_COLOR_PATTERN,
  TICKET_LABEL_LIMITS,
} from "@orkestrator/protocol/ticket-labels";
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
 * The ticket `kind`, `sections` and label fields shared by the worker agent tools and
 * the coordinator Control MCP. Values are checked again by
 * `parseTicketSectionsPatch` wherever they reach storage.
 */

const MAX_SECTION_TEXT = 100_000;
const sectionText = Schema.optionalKey(str({ max: MAX_SECTION_TEXT }));

export const ticketKindField = Schema.optionalKey(
  describe(Schema.Literals(TICKET_KINDS), TICKET_KIND_GUIDANCE),
);

export const ticketSectionsField = Schema.optionalKey(
  describe(
    strictObject({
      summary: sectionText,
      problem: sectionText,
      context: sectionText,
      decisions: sectionText,
      constraints: sectionText,
      acceptanceCriteria: Schema.optionalKey(
        list(str({ trim: true, min: 1, max: TICKET_SECTION_LIMITS.maxCriterionLength }), {
          max: TICKET_SECTION_LIMITS.maxAcceptanceCriteria,
        }),
      ),
      checks: Schema.optionalKey(
        list(str({ trim: true, min: 1, max: TICKET_SECTION_LIMITS.maxCheckLength }), {
          max: TICKET_SECTION_LIMITS.maxChecks,
        }),
      ),
      delivery: Schema.optionalKey(
        strictObject({
          policy: Schema.optionalKey(Schema.Literals(DELIVERY_POLICIES)),
          note: Schema.optionalKey(str({ max: MAX_SECTION_TEXT })),
        }),
      ),
      reporting: sectionText,
      outOfScope: sectionText,
      custom: Schema.optionalKey(
        list(
          strictObject({
            title: str({
              trim: true,
              min: 1,
              max: TICKET_SECTION_LIMITS.maxCustomTitleLength,
              pattern: /^[^\n]*$/,
              message: "Section titles are one line",
            }),
            body: str({ max: MAX_SECTION_TEXT }),
          }),
          { max: TICKET_SECTION_LIMITS.maxCustomSections },
        ),
      ),
      notes: sectionText,
    }),
    TICKET_SECTIONS_GUIDANCE,
  ),
);

export type TicketSectionsFieldValue = Infer<typeof ticketSectionsField>;

/** One label name; storage normalizes it again (`@orkestrator/protocol/ticket-labels`). */
export const ticketLabelNameField = describe(
  str({ trim: true, min: 1, max: TICKET_LABEL_LIMITS.maxNameLength }),
  "Label name; case is ignored when matching.",
);

export const ticketLabelsField = Schema.optionalKey(
  describe(
    list(ticketLabelNameField, { max: TICKET_LABEL_LIMITS.maxPerTicket }),
    "Label names (list_ticket_labels has the project's). Replaces every label; [] removes them all.",
  ),
);

export const ticketLabelColorField = Schema.optionalKey(
  describe(
    str({ pattern: TICKET_LABEL_COLOR_PATTERN, message: "A colour is #rrggbb" }),
    "Colour as #rrggbb.",
  ),
);

export const ticketLabelDescriptionField = Schema.optionalKey(
  describe(str({ max: TICKET_LABEL_LIMITS.maxDescriptionLength }), "What the label means."),
);

/** Each criterion's text in tool output; the full text is in `acceptanceCriteria`. */
const MAX_CRITERION_OUTPUT_CHARS = 500;
/** The whole `criteria` list in tool output. */
const MAX_CRITERIA_OUTPUT_BYTES = 32 * 1024;

/**
 * The structured part of a ticket in tool output. The text mirrors carry the
 * full content, so each criterion is a short handle (id, result, the start of
 * its text) and the list is bounded.
 */
export function ticketStructuredOutput(
  task: {
    kind?: unknown;
    sections?: TicketSections;
  },
  /** The build environment's HEAD now, so a Verify pass on older code says so. */
  environmentHead?: string,
): Record<string, unknown> {
  const criteria: Array<Record<string, unknown>> = [];
  let bytes = 2;
  let truncated = false;
  for (const criterion of ticketCriteriaSummary(task.sections, environmentHead)) {
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
