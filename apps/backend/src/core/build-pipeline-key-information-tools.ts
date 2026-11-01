/**
 * `get_key_information` and `update_key_information`: how a Build Pipeline's
 * stage agents keep the pipeline's key information current
 * (`build-pipeline-key-information.ts`).
 *
 * They are listed only to a credential whose environment a build pipeline
 * owns, on the general agent server and on a stage turn's workflow-result
 * server, so the Build, Fix, Address and Verify turns can reach them whichever
 * connection their turn runs on. They write only to the pipeline record.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  KEY_INFORMATION_FRAMINGS,
  KEY_INFORMATION_ISSUE_STATUSES,
  KEY_INFORMATION_LIMITS,
  KEY_INFORMATION_TEST_RESULTS,
  KEY_INFORMATION_TOOL_NAMES,
  type KeyInformationPatch,
} from "@orkestrator/protocol/build-pipeline-key-information";
import type {
  BuildPipelineKeyInformationHost,
  KeyInformationScope,
  KeyInformationView,
} from "./build-pipeline-key-information.js";

const [GET_TOOL, UPDATE_TOOL] = KEY_INFORMATION_TOOL_NAMES;

/** Inputs are bounded generously; the stored copy is cut to the record's limits. */
const INPUT_SLACK = 4;

// Each use builds its own schema so the published JSON Schema inlines every
// node rather than sharing one through `$ref`, which some providers reject.
const text = (limit: number) => z.string().max(limit * INPUT_SLACK);
const textList = (items: number, limit: number) => z.array(text(limit)).max(items * INPUT_SLACK);

function updateInputSchema() {
  const limits = KEY_INFORMATION_LIMITS;
  return z.object({
    framing: z
      .enum(KEY_INFORMATION_FRAMINGS)
      .optional()
      .describe(
        "`problem` when the ticket fixes something wrong (the default); `objective` when it adds or changes something that was not broken.",
      ),
    statement: text(limits.proseLength)
      .optional()
      .describe("The problem being solved, or the objective being completed, in a few sentences."),
    context: text(limits.proseLength)
      .optional()
      .describe("The situation around the work: where it lives, what it affects, constraints."),
    solution: text(limits.proseLength)
      .optional()
      .describe("The solution, as a reader would want it summarised."),
    workDone: textList(limits.listItems, limits.itemLength)
      .optional()
      .describe("What the agents did, one entry per notable piece of work."),
    decisions: z
      .array(
        z.object({
          decision: text(limits.decisionLength).describe("What had to be decided."),
          options: z
            .array(
              z.object({
                option: text(limits.optionLength),
                pros: textList(limits.prosCons, limits.optionLength),
                cons: textList(limits.prosCons, limits.optionLength),
              }),
            )
            .max(limits.options * INPUT_SLACK),
          chosen: text(limits.optionLength).describe("The option suggested and taken."),
          rationale: text(limits.rationaleLength).optional(),
        }),
      )
      .max(limits.decisions * INPUT_SLACK)
      .optional()
      .describe("Decisions made, each with every option considered and its pros and cons."),
    notDone: textList(limits.listItems, limits.itemLength)
      .optional()
      .describe("What was not done or needs further work."),
    tests: z
      .array(
        z.object({
          name: text(limits.testNameLength).describe("The command or test that ran."),
          result: z.enum(KEY_INFORMATION_TEST_RESULTS),
          details: text(limits.itemLength).optional(),
        }),
      )
      .max(limits.tests * INPUT_SLACK)
      .optional()
      .describe("The tests and checks that were run, with their result."),
    issues: z
      .array(
        z.object({
          issue: text(limits.issueLength),
          severity: text(limits.severityLength).optional(),
          resolution: text(limits.resolutionLength).describe("How it was solved, or why not."),
          status: z.enum(KEY_INFORMATION_ISSUE_STATUSES),
        }),
      )
      .max(limits.issues * INPUT_SLACK)
      .optional()
      .describe(
        "The current round's review issues and how each was handled. Replaces this round's issues only; earlier rounds are kept.",
      ),
    verification: z
      .object({
        passed: z.boolean().optional(),
        summary: text(limits.summaryLength),
        checks: z
          .array(
            z.object({
              check: text(limits.checkLength),
              passed: z.boolean(),
              details: text(limits.itemLength).optional(),
            }),
          )
          .max(limits.checks * INPUT_SLACK),
      })
      .optional()
      .describe(
        "The current round's verification: each check and whether it passed, and what failed. Replaces this round's entry only.",
      ),
  });
}

function viewResult(view: KeyInformationView) {
  const value = { ...view } as unknown as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/**
 * Registers both tools when a build pipeline owns the scope's environment.
 * Resolves whether it registered them.
 */
export async function registerKeyInformationTools(
  server: McpServer,
  host: BuildPipelineKeyInformationHost,
  scope: KeyInformationScope,
): Promise<boolean> {
  const owner = await host.read(scope).catch(() => null);
  if (!owner) return false;
  server.registerTool(
    GET_TOOL,
    {
      title: "Read the pipeline's key information",
      description:
        "Read the key information of the build pipeline you are working in: the problem or objective, context, solution, work done, decisions, what was not done, tests, review issues and verification results recorded so far. Read it before updating so you keep what earlier stages wrote.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const view = await host.read(scope);
      if (!view) throw new Error("No build pipeline owns this environment.");
      return viewResult(view);
    },
  );
  server.registerTool(
    UPDATE_TOOL,
    {
      title: "Update the pipeline's key information",
      description:
        "Update the key information the user reads in the build pipeline header. Each field you pass replaces that whole section, so include the entries you want to keep; omitted fields are left unchanged. `issues` and `verification` apply to the current round only. Write for a reader who has not seen the transcript: short, specific and accurate.",
      inputSchema: updateInputSchema(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const patch = input as KeyInformationPatch;
      if (Object.values(patch).every((value) => value === undefined)) {
        throw new Error("Provide at least one key information section to update.");
      }
      return viewResult(await host.update(scope, patch));
    },
  );
  return true;
}
