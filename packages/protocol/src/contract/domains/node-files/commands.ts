/**
 * `node-files` commands (plan item 1010): one node's files read and written
 * in bounded chunks (any node; a command node calls them on itself and its
 * nodes), and the command node's transfers between nodes.
 *
 * Every command here was strict before (`assertOnlyKeys`); the argument
 * schemas declare exactly those keys and decode tolerantly (§11.4). The
 * handlers keep their own checks (`parseNodeFileScope`, the non-negative
 * integer checks), so those arguments stay `Unknown` here and their error
 * text is unchanged. Results crossing the node link have optional fields: a
 * pre-contract node, or a fake in a test, may answer less.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { nodeFilesDomain } from "./domain.js";

const optionalString = Schema.optionalKey(Schema.String);
const optionalBoolean = Schema.optionalKey(Schema.Boolean);
const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const optionalSize = Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));

/** Whether a file exists in a scope, and its size and SHA-256 when it does. */
export const statNodeFileCommand = defineCommand({
  domain: nodeFilesDomain,
  name: "stat_node_file",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ scope: optionalUnknown, path: optionalUnknown }),
  result: Schema.Struct({ exists: optionalBoolean, size: optionalSize, sha256: optionalString }),
  critical: [],
});

/** One chunk of a file, base64. */
export const readNodeFileCommand = defineCommand({
  domain: nodeFilesDomain,
  name: "read_node_file",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({
    scope: optionalUnknown,
    path: optionalUnknown,
    offset: optionalUnknown,
    length: optionalUnknown,
  }),
  result: Schema.Struct({
    contentBase64: optionalString,
    size: optionalSize,
    eof: optionalBoolean,
  }),
  critical: [],
});

/** Starts an upload; the file appears only when commit verifies its size and hash. */
export const beginNodeFileWriteCommand = defineCommand({
  domain: nodeFilesDomain,
  name: "begin_node_file_write",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    path: optionalUnknown,
    size: optionalUnknown,
    sha256: optionalUnknown,
    overwrite: optionalUnknown,
  }),
  result: Schema.Struct({ uploadId: optionalString }),
  // sha256: the destination verifies the file against it before it appears;
  // ignoring it would accept a corrupted copy. (An ignored `overwrite` falls
  // back to refusing to replace a file, which is safe.)
  critical: ["sha256"],
});

export const appendNodeFileWriteCommand = defineCommand({
  domain: nodeFilesDomain,
  name: "append_node_file_write",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ uploadId: optionalUnknown, contentBase64: optionalUnknown }),
  result: Schema.Struct({ written: optionalSize }),
  critical: [],
});

export const commitNodeFileWriteCommand = defineCommand({
  domain: nodeFilesDomain,
  name: "commit_node_file_write",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ uploadId: optionalUnknown }),
  result: Schema.Struct({ bytes: optionalSize, sha256: optionalString }),
  critical: [],
});

export const abortNodeFileWriteCommand = defineCommand({
  domain: nodeFilesDomain,
  name: "abort_node_file_write",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ uploadId: optionalUnknown }),
  result: Schema.Struct({ aborted: optionalBoolean }),
  critical: [],
});

/**
 * A transfer receipt. Only the fields every receipt has are described; the
 * endpoints, files and error pass through unchanged.
 */
export const NodeTransferReceiptSchema = Schema.Struct({
  transferId: Schema.String,
  status: Schema.Literals(["running", "completed", "failed"]),
  bytes: Schema.Finite,
  actor: Schema.String,
  startedAt: Schema.String,
});

/** Copies files between nodes (command node). */
export const transferNodeFilesCommand = defineCommand({
  domain: nodeFilesDomain,
  name: "transfer_node_files",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    from: optionalUnknown,
    to: optionalUnknown,
    files: optionalUnknown,
    toDirectory: optionalUnknown,
    overwrite: optionalUnknown,
    actor: optionalUnknown,
  }),
  result: NodeTransferReceiptSchema,
  critical: [],
});

export const listNodeTransfersCommand = defineCommand({
  domain: nodeFilesDomain,
  name: "list_node_transfers",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: Schema.Array(NodeTransferReceiptSchema),
  critical: [],
});

/** Every `node-files` command definition, in registration order. */
export const NODE_FILES_COMMANDS = [
  statNodeFileCommand,
  readNodeFileCommand,
  beginNodeFileWriteCommand,
  appendNodeFileWriteCommand,
  commitNodeFileWriteCommand,
  abortNodeFileWriteCommand,
  transferNodeFilesCommand,
  listNodeTransfersCommand,
] as const;
