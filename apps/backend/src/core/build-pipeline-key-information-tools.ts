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
import { Schema } from "effect";
import { describe, list, str, toolInput } from "./tool-schema.js";
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
const text = (limit: number) => str({ max: limit * INPUT_SLACK });
const textList = (items: number, limit: number) => list(text(limit), { max: items * INPUT_SLACK });

function updateInputSchema() {
  const limits = KEY_INFORMATION_LIMITS;
  return Schema.Struct({
    framing: Schema.optionalKey(
      describe(
        Schema.Literals(KEY_INFORMATION_FRAMINGS),
        "`problem` when the ticket fixes something wrong (the default); `objective` when it adds or changes something that was not broken.",
      ),
    ),
    summary: Schema.optionalKey(
      describe(
        text(limits.proseLength),
        "The change as a whole, in plain language for a reader who does not know the code: what changed and why it matters. No file names, identifiers or jargon. Two to four short paragraphs separated by a blank line, with `- ` bullet lines where the points are a list; never one long block.",
      ),
    ),
    statement: Schema.optionalKey(
      describe(
        text(limits.proseLength),
        "The problem being solved, or the objective being completed, in a few sentences. Separate paragraphs with a blank line; `- ` lines show as bullets.",
      ),
    ),
    context: Schema.optionalKey(
      describe(
        text(limits.proseLength),
        "The situation around the work: where it lives, what it affects, constraints. Separate paragraphs with a blank line; `- ` lines show as bullets.",
      ),
    ),
    solution: Schema.optionalKey(
      describe(
        text(limits.proseLength),
        "The solution, as a reader would want it summarised. Separate paragraphs with a blank line; `- ` lines show as bullets.",
      ),
    ),
    workDone: Schema.optionalKey(
      describe(
        textList(limits.listItems, limits.itemLength),
        "What the agents did, one entry per notable piece of work.",
      ),
    ),
    decisions: Schema.optionalKey(
      describe(
        list(
          Schema.Struct({
            decision: describe(
              text(limits.decisionLength),
              "The material technical choice the user should know about.",
            ),
            options: list(
              Schema.Struct({
                option: text(limits.optionLength),
                pros: textList(limits.prosCons, limits.optionLength),
                cons: textList(limits.prosCons, limits.optionLength),
              }),
              { max: limits.options * INPUT_SLACK },
            ),
            chosen: describe(text(limits.optionLength), "The option implemented or selected."),
            rationale: Schema.optionalKey(
              describe(
                text(limits.rationaleLength),
                "Brief engineering justification supported by requirements, code, constraints or tests; never private internal reasoning or chain of thought.",
              ),
            ),
          }),
          { max: limits.decisions * INPUT_SLACK },
        ),
        "Concise records of material technical decisions: the chosen option and relevant alternatives with engineering pros and cons. Do not invent alternatives or claim an exhaustive record of options considered. Do not perform reasoning extraction or disclose or reconstruct private internal reasoning, hidden deliberations or chain of thought.",
      ),
    ),
    notDone: Schema.optionalKey(
      describe(
        textList(limits.listItems, limits.itemLength),
        "What was not done or needs further work.",
      ),
    ),
    tests: Schema.optionalKey(
      describe(
        list(
          Schema.Struct({
            name: describe(text(limits.testNameLength), "The command or test that ran."),
            result: Schema.Literals(KEY_INFORMATION_TEST_RESULTS),
            details: Schema.optionalKey(text(limits.itemLength)),
          }),
          { max: limits.tests * INPUT_SLACK },
        ),
        "The tests and checks that were run, with their result.",
      ),
    ),
    issues: Schema.optionalKey(
      describe(
        list(
          Schema.Struct({
            issue: text(limits.issueLength),
            severity: Schema.optionalKey(text(limits.severityLength)),
            resolution: describe(text(limits.resolutionLength), "How it was solved, or why not."),
            status: Schema.Literals(KEY_INFORMATION_ISSUE_STATUSES),
          }),
          { max: limits.issues * INPUT_SLACK },
        ),
        "The current round's review issues and how each was handled. Replaces this round's issues only; earlier rounds are kept.",
      ),
    ),
    verification: Schema.optionalKey(
      describe(
        Schema.Struct({
          passed: Schema.optionalKey(Schema.Boolean),
          summary: text(limits.summaryLength),
          checks: list(
            Schema.Struct({
              check: text(limits.checkLength),
              passed: Schema.Boolean,
              details: Schema.optionalKey(text(limits.itemLength)),
            }),
            { max: limits.checks * INPUT_SLACK },
          ),
        }),
        "The current round's verification: each check and whether it passed, and what failed. Replaces this round's entry only.",
      ),
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
        "Read the key information of the build pipeline you are working in: the summary, the problem or objective, context, solution, work done, decisions, what was not done, tests, review issues and verification results recorded so far. Read it before updating so you keep what earlier stages wrote.",
      inputSchema: toolInput(Schema.Struct({})),
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
        "Update the key information the user reads in the build pipeline header. Each field you pass replaces that whole section, so include the entries you want to keep; omitted fields are left unchanged. `issues` and `verification` apply to the current round only. Write for a reader who has not seen the transcript: short, specific and accurate. Record observable work and concise engineering decision summaries only. Do not perform reasoning extraction: do not disclose, reconstruct or request private internal reasoning, hidden deliberations or chain of thought.",
      inputSchema: toolInput(updateInputSchema()),
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
