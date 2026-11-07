/**
 * The `files` domain client (plan item 7002; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (`expected` on the two writes and `digest`
 *   on the evidence removal are critical).
 * - Version 0 (a pre-contract node) is today's untyped call, `{ command,
 *   args }`, answered as sent (`legacyCommandApi`). No file command was
 *   capability-gated; older nodes differ only in what they answer (no `view`
 *   stamp), which the callers already normalise.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `files` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { FILES_COMMANDS } from "./commands.js";
import { filesDomain } from "./domain.js";

export type FilesApi = CommandApi<typeof FILES_COMMANDS>;

const filesApi = (call: CommandCall): FilesApi => commandApi(call, FILES_COMMANDS);
const legacyFilesApi = (_call: CommandCall, context: DomainAdapterContext): FilesApi =>
  legacyCommandApi(context, FILES_COMMANDS);

export const filesClient = domainClient(filesDomain, { 1: filesApi, 0: legacyFilesApi });
