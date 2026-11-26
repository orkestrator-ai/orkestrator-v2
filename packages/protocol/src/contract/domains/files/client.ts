/**
 * The `files` domain client (plan item 7002; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (`expected` on the two writes and `digest`
 *   on the evidence removal are critical).
 *
 * Only the current version has an adapter: the older ones went with the
 * one-time support floor v2.39.1-beta (to-do 8304 (retired), 2026-11-26). A domains map
 * that omits this domain yields `unsupported-version`. Without a domains
 * map, calls use the lowest adapter unnegotiated. Later bumps keep an
 * adapter for every version a release in the 60-day window speaks.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall } from "../../client.js";
import { commandApi, type CommandApi } from "../command-api.js";
import { FILES_COMMANDS } from "./commands.js";
import { filesDomain } from "./domain.js";

export type FilesApi = CommandApi<typeof FILES_COMMANDS>;

const filesApi = (call: CommandCall): FilesApi => commandApi(call, FILES_COMMANDS);

export const filesClient = domainClient(filesDomain, { 1: filesApi });
