/**
 * The `node-files` domain client (plan item 1010; §11.2 "Client adapters"):
 * one node's chunked file reads and writes, which the command node's
 * transfers (`nodes/node-file-transfer.ts`) run on a source and a
 * destination node. Built per node over the node link
 * (`apps/backend/src/core/nodes/node-domain-clients.ts`).
 *
 * Version 1 sends the envelope (`sha256` on `begin_node_file_write` is
 * critical). The `mailAttachments` scope is gated by the
 * `node-mail-attachments` capability where the images are pushed
 * (`coordinator/mail-attachments.ts`), not here.
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
import type { AnyCommandDef, ArgsOf, ResultOf } from "../../command.js";
import {
  abortNodeFileWriteCommand,
  appendNodeFileWriteCommand,
  beginNodeFileWriteCommand,
  commitNodeFileWriteCommand,
  readNodeFileCommand,
  statNodeFileCommand,
} from "./commands.js";
import { nodeFilesDomain } from "./domain.js";

type Call<C extends AnyCommandDef> = (args: ArgsOf<C>) => Promise<ResultOf<C>>;

export interface NodeFilesApi {
  stat: Call<typeof statNodeFileCommand>;
  read: Call<typeof readNodeFileCommand>;
  beginWrite: Call<typeof beginNodeFileWriteCommand>;
  appendWrite: Call<typeof appendNodeFileWriteCommand>;
  commitWrite: Call<typeof commitNodeFileWriteCommand>;
  abortWrite: Call<typeof abortNodeFileWriteCommand>;
}

/** The API over any command call: the adapter, and a node's own local commands. */
export function nodeFilesApi(call: CommandCall): NodeFilesApi {
  return {
    stat: (args) => call(statNodeFileCommand, args),
    read: (args) => call(readNodeFileCommand, args),
    beginWrite: (args) => call(beginNodeFileWriteCommand, args),
    appendWrite: (args) => call(appendNodeFileWriteCommand, args),
    commitWrite: (args) => call(commitNodeFileWriteCommand, args),
    abortWrite: (args) => call(abortNodeFileWriteCommand, args),
  };
}

export const nodeFilesClient = domainClient(nodeFilesDomain, {
  1: nodeFilesApi,
});
