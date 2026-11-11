import type { McpServer } from "@modelcontextprotocol/server";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { COORDINATOR_WORKER_PROMPT_FORMAT_RULE } from "@orkestrator/protocol/coordinator";
import { Schema } from "effect";
import { describe, int, list, str, strictObject, toolInput } from "../tool-schema.js";
import { createNodeTargets } from "./nodes.js";
import { isRecord, readAnnotations, toolResult, type JsonRecord } from "./tool-support.js";
import type { CoordinatorControlScope } from "./tools.js";
import {
  launchOptions,
  launchSelectionReport,
  launchSettingsTiers,
  validateSelection,
  type ControlMcpInvoker,
} from "../control-shared-actions.js";
import { WORKER_CHANGES_LIMITS, WORKER_DIFF_SCOPES } from "../coordinator-worker-changes-limits.js";

/**
 * Coordinator tools that read or branch off one worker: `get_worker_changes`
 * (what it changed, read-only) and `fork_worker` (a new worker from where it
 * got to). Backend commands: `coordinator-worker-changes.ts` and
 * `coordinator-fork-worker.ts`, which revalidate the scope and refuse the
 * project home.
 */

/**
 * `get_worker_changes` only reads, so it is `discovery`: a side agent is
 * asked to read and discuss work, and the worker's diff is that work. The
 * checkout's read-only boundary is unchanged; nothing is written anywhere.
 * `fork_worker` creates a worker, so it is the main coordinator's
 * (`environments`), like `launch_environment`.
 */
export const COORDINATOR_WORKER_TOOL_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  ["get_worker_changes", "discovery"],
  ["fork_worker", "environments"],
];

const L = WORKER_CHANGES_LIMITS;
const environmentId = str({ trim: true, min: 1, max: 200 });
const workerNodeId = Schema.optionalKey(
  describe(
    str({ trim: true, min: 1, max: 200 }),
    "The worker's nodeId from list_nodes; omit for this node.",
  ),
);
const workerPath = str({ trim: true, min: 1, max: L.maxPathChars });

function asyncDelegationResult(): JsonRecord {
  return {
    delivery: "async",
    wake: "This conversation will be woken with a message when the fork's turn ends. Progress it sends before then is held and delivered with that wake, so silence means it is still working.",
    nextStep: "Finish your turn now. Do not poll.",
  };
}

export function registerCoordinatorWorkerTools(
  server: McpServer,
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
): void {
  const identity = {
    projectId: scope.projectId,
    coordinatorId: scope.coordinatorId,
    conversationId: scope.conversationId,
    ...(scope.turnOrigin ? { turnOrigin: scope.turnOrigin } : {}),
  };
  const call = async (command: string, args: JsonRecord) =>
    invoke<JsonRecord>(command, { scope: identity, ...args });

  server.registerTool(
    "get_worker_changes",
    {
      title: "Read what a worker changed",
      description:
        "Read a worker environment's changes, local or container, without fetching its branch: its branch and base, the commits since the base, the files changed since the base (committed and uncommitted together) with status and line counts, the files its commits changed, the files not yet committed, and a unified diff of the listed files. The diff is base to working tree unless diffScope asks for committed (base to HEAD), uncommitted (HEAD to working tree) or split (both, separately). Read-only, never the project checkout (read that directly). Everything is bounded; when something is cut the result says truncated and how to narrow: page files with offset, pass paths (files or directories), or file for one file's whole diff. Pass nodeId for a worker on another connected node.",
      inputSchema: toolInput(
        strictObject({
          environmentId,
          nodeId: workerNodeId,
          paths: Schema.optionalKey(
            describe(
              list(workerPath, { min: 1, max: L.maxPaths }),
              "Only these files or directories (paths inside the worker).",
            ),
          ),
          file: Schema.optionalKey(
            describe(workerPath, "One file: its whole diff, up to maxDiffBytes. Not with paths."),
          ),
          offset: Schema.optionalKey(
            describe(
              int({ min: 0, max: L.maxScannedRows }),
              "Skip this many changed files (sinceBase.nextOffset from the last read).",
            ),
          ),
          maxFiles: Schema.optionalKey(int({ min: 1, max: L.maxFiles })),
          maxCommits: Schema.optionalKey(int({ min: 0, max: L.maxCommits })),
          includeDiff: Schema.optionalKey(
            describe(Schema.Boolean, "false lists files and counts without diffs."),
          ),
          diffScope: Schema.optionalKey(
            describe(
              Schema.Literals(WORKER_DIFF_SCOPES),
              "Which diff: sinceBase (default, base to working tree, in diffs), committed (base to HEAD, in committedDiffs), uncommitted (HEAD to working tree, in uncommittedDiffs) or split (both, sharing maxDiffBytes).",
            ),
          ),
          maxDiffFiles: Schema.optionalKey(int({ min: 0, max: L.maxDiffFiles })),
          maxDiffBytes: Schema.optionalKey(
            describe(
              int({ min: 1_024, max: L.maxTotalDiffBytes }),
              "Total diff bytes in this answer; each file gets at most 16 KiB unless file is used.",
            ),
          ),
        }),
      ),
      annotations: readAnnotations(),
    },
    async (input) => toolResult(await call("get_coordinator_worker_changes", { input })),
  );

  server.registerTool(
    "fork_worker",
    {
      title: "Fork a worker to try an alternative",
      description:
        "Fork one of this project's worker environments, as the sidebar's Fork does: a new worker on its own branch, starting from the worker's last commit (its uncommitted changes and its conversation are not copied; ask the worker to commit first if they matter), with its agent settings. With a prompt, the fork's agent starts on it and you are woken once when that turn ends, as for launch_environment; without one the fork starts with no agent turn. Omit agent, modelId and reasoningId to run the user's saved defaults (the worker's own agent). The fork never owns the worker's build pipeline. A container fork needs the commit pushed to a remote. Never the project checkout. Pass nodeId for a worker on another connected node. Reuse requestId only to retry the same fork.",
      inputSchema: toolInput(
        strictObject({
          requestId: describe(
            str({ trim: true, min: 1, max: 256 }),
            "Stable key for this action; reuse it only to retry the same call.",
          ),
          environmentId: describe(environmentId, "The worker to fork."),
          nodeId: workerNodeId,
          environmentType: Schema.optionalKey(
            describe(
              Schema.Literals(["local", "containerized"]),
              "Omit to fork into the worker's own type.",
            ),
          ),
          prompt: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 100_000 }),
              `What the fork's agent should try. ${COORDINATOR_WORKER_PROMPT_FORMAT_RULE} Ask it to commit and report back, never to open a pull request.`,
            ),
          ),
          agent: Schema.optionalKey(
            describe(
              Schema.Literals(AGENT_PLATFORMS as unknown as [AgentPlatform, ...AgentPlatform[]]),
              "Omit to use the worker's agent (the saved default).",
            ),
          ),
          modelId: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 500 }),
              "Omit to use the saved default model. Needs agent.",
            ),
          ),
          reasoningId: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 100 }),
              "Omit to use the saved default effort. Needs modelId.",
            ),
          ),
          conversationMode: Schema.optionalKey(Schema.Literals(["plan", "build"])),
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      if (input.modelId && !input.agent) throw new Error("modelId needs agent");
      const target = input.nodeId
        ? await createNodeTargets(invoke, identity).targetOrSelf(input.nodeId)
        : null;
      const inv = target?.invoke ?? invoke;
      const projectId = target?.projectId ?? scope.projectId;
      // An explicit choice is checked against the worker's node before anything is made.
      const options = input.agent
        ? await validateSelection(inv, {
            projectId,
            environmentId: input.environmentId,
            agent: input.agent,
            ...(input.modelId ? { modelId: input.modelId } : {}),
            ...(input.reasoningId ? { reasoningId: input.reasoningId } : {}),
          })
        : null;
      const result = await call("fork_coordinator_worker", { input });
      const agent = result.agent as AgentPlatform | null | undefined;
      let selection: JsonRecord = {};
      if (input.prompt && agent && typeof result.environmentId === "string") {
        try {
          const environment = await inv<unknown>("get_environment", {
            environmentId: result.environmentId,
          });
          const tiers = await launchSettingsTiers(
            inv,
            projectId,
            isRecord(environment) ? environment : undefined,
          );
          const models =
            options?.models ?? (await launchOptions(inv, projectId, result.environmentId)).models;
          selection = {
            selection: {
              ...launchSelectionReport(
                tiers,
                models,
                { agent, modelId: input.modelId, reasoningId: input.reasoningId },
                false,
              ),
              // The startup tab has not accepted it yet, as for launch_environment.
              advisory: true,
            },
          };
        } catch {
          // The report is advisory; a failed settings read leaves it out.
        }
      }
      return toolResult({
        ...result,
        ...selection,
        ...(result.coordinatorDelegationOpened === true ? asyncDelegationResult() : {}),
      });
    },
  );
}
