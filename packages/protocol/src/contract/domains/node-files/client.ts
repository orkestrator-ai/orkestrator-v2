/**
 * The `node-files` domain client (plan item 1010; §11.2 "Client adapters"):
 * one node's chunked file reads and writes, which the command node's
 * transfers (`nodes/node-file-transfer.ts`) run on a source and a
 * destination node. Built per node over the node link
 * (`apps/backend/src/core/nodes/node-domain-clients.ts`).
 *
 * The file commands were never capability-gated, so both adapters call the
 * same commands. Version 1 sends the envelope (`sha256` on
 * `begin_node_file_write` is critical); version 0, for a pre-contract node,
 * sends today's `{ command, args }`. The `mailAttachments` scope is gated by
 * the `node-mail-attachments` capability where the images are pushed
 * (`coordinator-mail-attachments.ts`), not here.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `node-files` domain.
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

/** The API over any command call: both adapters, and a node's own local commands. */
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
  0: nodeFilesApi,
});
