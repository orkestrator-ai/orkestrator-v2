/**
 * The `pipelines` domain client (plan item 7007; §11.2 "Client adapters"):
 * one function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (`existingEnvironmentId` and
 *   `deliveryPolicy` on the launches, `requestId` on a feature build, a
 *   restart's `selection` and the unread badge's `expectedLastActivityAt` are
 *   critical) and decodes the results with the schemas in `./schemas.ts`.
 * - Version 0 (a pre-contract node) is today's untyped call, answered as
 *   sent (`legacyCommandApi`). No pipeline command was capability-gated: the
 *   older-backend answers (`launch_build_pipeline`, `start_feature_plan_build`
 *   missing) read an `unknown-command`, which both adapters pass through.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `pipelines` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { PIPELINES_COMMANDS } from "./commands.js";
import { pipelinesDomain } from "./domain.js";

export type PipelinesApi = CommandApi<typeof PIPELINES_COMMANDS>;

const pipelinesApi = (call: CommandCall): PipelinesApi => commandApi(call, PIPELINES_COMMANDS);
const legacyPipelinesApi = (_call: CommandCall, context: DomainAdapterContext): PipelinesApi =>
  legacyCommandApi(context, PIPELINES_COMMANDS);

export const pipelinesClient = domainClient(pipelinesDomain, {
  1: pipelinesApi,
  0: legacyPipelinesApi,
});
