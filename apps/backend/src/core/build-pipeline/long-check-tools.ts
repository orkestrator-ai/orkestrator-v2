/**
 * `start_long_check` and `get_long_checks`: how a Build Pipeline stage hands a
 * slow command to the pipeline instead of running it in its own turn
 * (`long-checks.ts`).
 *
 * Listed only to a credential whose environment a build pipeline owns, on the
 * same servers as the key information tools. Starting a check is refused
 * unless the caller is the running Build, Rework, Address Findings or Verify
 * stage's own worker or dispatch.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import {
  PIPELINE_LONG_CHECK_LIMITS,
  PIPELINE_LONG_CHECK_TOOL_NAMES,
} from "@orkestrator/protocol/build-pipeline-long-checks";
import { REVIEW_VALIDATION_SCOPES } from "@orkestrator/protocol/review-workflow";
import { describe, list, num, str, toolInput } from "../tool-schema.js";
import type { KeyInformationScope } from "./key-information.js";
import type { BuildPipelineLongCheckHost, StartLongCheckInput } from "./long-checks.js";

const [START_TOOL, LIST_TOOL] = PIPELINE_LONG_CHECK_TOOL_NAMES;

function startInputSchema() {
  const limits = PIPELINE_LONG_CHECK_LIMITS;
  return Schema.Struct({
    name: describe(
      str({ trim: true, min: 1, max: limits.nameLength }),
      "A short name the user will recognise on the ticket, such as `corpus parity` or `browser suite`.",
    ),
    criterion: Schema.optionalKey(
      describe(
        str({ trim: true, max: limits.criterionLength }),
        "The acceptance criterion this check settles, when it settles one.",
      ),
    ),
    commands: describe(
      list(
        Schema.Struct({
          command: describe(
            str({ min: 1, max: limits.commandLength }),
            "The shell command, run with Bash in the workspace.",
          ),
          cwd: Schema.optionalKey(
            describe(
              str({ max: limits.cwdLength }),
              "Working directory relative to the workspace root. Defaults to the root.",
            ),
          ),
          timeoutMinutes: Schema.optionalKey(
            describe(
              num({ min: limits.minTimeoutMinutes, max: limits.maxTimeoutMinutes }),
              `How long this command may run before it is stopped and recorded as incomplete. Default ${limits.defaultTimeoutMinutes}.`,
            ),
          ),
          scope: Schema.optionalKey(
            describe(
              Schema.Literals(REVIEW_VALIDATION_SCOPES),
              "`changed` for the narrow run over what this change touched (its own specs or cases), `general` (the default) for a whole suite or corpus. Changed commands run first, so their result exists even if a general one runs out of time.",
            ),
          ),
        }),
        { min: 1, max: limits.commands },
      ),
      `One to ${limits.commands} commands. List the narrow \`changed\` command before the full run.`,
    ),
    capability: Schema.optionalKey(
      describe(
        str({ max: 4096 }),
        "Signed worker or workflow capability, required on a shared connection.",
      ),
    ),
  });
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/** What the agent is told after a start: what happens next, and not to poll. */
export const LONG_CHECK_STARTED_NOTE =
  "The pipeline now owns this check and runs it in the background, outside your turn: it survives tool and monitor timeouts and backend restarts. Do not poll `get_long_checks`, sleep or wait on it. Carry on with work that does not depend on it, then end your turn; the pipeline holds this stage until the check finishes, posts its result on the ticket, and sends you the result in a new turn. Do not mark a criterion it settles as passed before then.";

/**
 * Registers both tools when a build pipeline owns the scope's environment.
 * Resolves whether it registered them.
 */
export async function registerLongCheckTools(
  server: McpServer,
  host: BuildPipelineLongCheckHost,
  scope: KeyInformationScope,
  resolveCallerScope?: (capability: string | undefined) => Promise<KeyInformationScope>,
): Promise<boolean> {
  if (!(await host.owns(scope).catch(() => false))) return false;
  server.registerTool(
    START_TOOL,
    {
      title: "Start a long check",
      description:
        "Hand a slow check to the build pipeline instead of running it in your turn: a corpus or parity comparison, a byte-identity run, a full test, browser or performance suite, anything that may take more than a few minutes. The pipeline runs it on the environment's validation worker, posts the result on the ticket, and sends it to you in a new turn when it finishes; your stage cannot finish before then. Put every command the check needs in one call (one check runs at a time), with the narrow `changed` command first. Commit what the check should cover first: it runs against the current workspace.",
      inputSchema: toolInput(startInputSchema()),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const { capability, ...request } = input as StartLongCheckInput & { capability?: string };
      // The caller's identity is the backend-authenticated tab or result key
      // of this connection, or the signed capability on a shared one.
      const caller = resolveCallerScope
        ? await resolveCallerScope(capability).catch(() => {
            throw new Error(
              "This connection does not identify the running stage. Pass the signed worker or workflow capability from your turn instructions as `capability`.",
            );
          })
        : scope;
      const check = await host.start(caller, request);
      return jsonResult({ check, note: LONG_CHECK_STARTED_NOTE });
    },
  );
  server.registerTool(
    LIST_TOOL,
    {
      title: "Read the pipeline's long checks",
      description:
        "Read the build pipeline's long checks: each one's status, elapsed time and per-command progress (output byte counts and artifact paths, never output). You do not need this to receive a result: the pipeline sends it to your stage when the check finishes. Use it to see what an earlier stage or attempt ran.",
      inputSchema: toolInput(Schema.Struct({})),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => jsonResult(await host.list(scope)),
  );
  return true;
}
