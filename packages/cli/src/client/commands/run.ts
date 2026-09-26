import { isPublicActionName, type PublicReceipt } from "@orkestrator/protocol/public-api";
import type { PublicExecOutputWindow } from "@orkestrator/protocol/public-api-resources";
import { CliError } from "../errors.js";
import { receiptLines, table } from "../format.js";
import { LocalReceiptStore } from "../receipts.js";
import type { CommandSpec } from "../spec.js";
import {
  DEFAULT_WAIT_MS,
  oneOf,
  readOperation,
  receiptFailure,
  REQUEST_ID_OPTION,
  stringOption,
  submit,
  TIMEOUT_OPTION,
  waitForOperation,
} from "./common.js";

export const runCommands: CommandSpec[] = [
  {
    path: ["run", "get"],
    summary: "Show an operation by ID, or by its original --request-id.",
    description:
      "Lookup by request key finds the operation even when the original response was lost. `history-expired` (exit 3) means the key's namespace was retired and its outcome is no longer retained; it is not evidence that nothing ran.",
    positionals: [{ name: "operation", required: false }],
    options: [
      {
        name: "request-id",
        kind: "string",
        valueName: "KEY",
        description: "The original request key.",
      },
      {
        name: "action",
        kind: "string",
        valueName: "ACTION",
        description: "Action the key was used with (e.g. environment.create).",
      },
      {
        name: "namespace",
        kind: "string",
        valueName: "NAMESPACE",
        description: "Namespace from a saved receipt.",
      },
    ],
    idOutput: "operation ID",
    async run(context, parsed) {
      const operationId = parsed.positionals.operation as string | undefined;
      const requestId = stringOption(parsed.options, "request-id");
      if ((operationId ? 1 : 0) + (requestId ? 1 : 0) !== 1) {
        throw new CliError("invalid-input", "Pass an operation ID or --request-id");
      }
      const action = stringOption(parsed.options, "action");
      if (action !== undefined && !isPublicActionName(action)) {
        throw new CliError("invalid-input", "--action is not a public action name");
      }
      const session = await context.session();
      let namespace = stringOption(parsed.options, "namespace");
      if (requestId && !namespace && action) {
        const capabilities = await session.capabilities();
        const local = await new LocalReceiptStore(context.configStore.receiptsDirectory).find(
          capabilities.backend.installationId,
          action,
          requestId,
        );
        namespace = local?.namespace;
      }
      const { receipt } = await session.readWithReceipt(
        "run.get",
        operationId
          ? { operationId }
          : { requestId, ...(action ? { action } : {}), ...(namespace ? { namespace } : {}) },
      );
      if (!receipt) throw new CliError("response-invalid", "run.get returned no receipt");
      return {
        action: "run.get",
        result: null,
        receipt,
        connection: session.identity,
        ids: [receipt.operationId],
        human: receiptLines(receipt),
      };
    },
  },
  {
    path: ["run", "wait"],
    summary: "Observe an operation until it finishes (exit 0 only on success).",
    description:
      "Exit codes: 0 succeeded, 1 failed/cancelled/interrupted, 5 --timeout passed (still running), 6 waiting for an interaction answer, 7 dispatch or outcome unknown. Ctrl+C stops observing only.",
    positionals: [{ name: "operation", required: true }],
    options: [
      TIMEOUT_OPTION,
      {
        name: "continue-on-interaction",
        kind: "boolean",
        description: "Keep waiting while an interaction is pending (another client may answer it).",
      },
    ],
    idOutput: "operation ID",
    async run(context, parsed) {
      const session = await context.session();
      const initial = await readOperation(session, String(parsed.positionals.operation));
      const final = await waitForOperation(
        context,
        session,
        initial,
        (parsed.options.timeout as number | undefined) ?? DEFAULT_WAIT_MS,
        { continueOnInteraction: parsed.options["continue-on-interaction"] === true },
      );
      const failure = receiptFailure(final);
      return {
        action: "run.wait",
        result: null,
        receipt: final,
        connection: session.identity,
        ids: [final.operationId],
        human: receiptLines(final),
        ...(failure ? { failure } : {}),
      };
    },
  },
  {
    path: ["run", "retry"],
    summary: "Retry the exact parked prompt/steer of an unknown dispatch under its original key.",
    description: "Never sends a different prompt and never mints a new key.",
    positionals: [{ name: "operation", required: true }],
    options: [REQUEST_ID_OPTION],
    idOutput: "operation ID",
    async run(context, parsed) {
      const { session, result, receipt, warnings } = await submit(
        context,
        "run.retry",
        { operationId: parsed.positionals.operation },
        parsed.options,
      );
      return {
        action: "run.retry",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: receipt ? [receipt.operationId] : [],
        human: receipt ? receiptLines(receipt) : ["retried"],
      };
    },
  },
  {
    path: ["run", "discard"],
    summary: "Clear the recovery state of an unknown dispatch (does NOT undo a turn that ran).",
    positionals: [{ name: "operation", required: true }],
    options: [REQUEST_ID_OPTION],
    idOutput: "operation ID",
    async run(context, parsed) {
      const { session, result, receipt, warnings } = await submit(
        context,
        "run.discard",
        { operationId: parsed.positionals.operation },
        parsed.options,
      );
      return {
        action: "run.discard",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: receipt ? [receipt.operationId] : [],
        human: receipt ? receiptLines(receipt) : ["discarded"],
      };
    },
  },
  {
    path: ["run", "cancel"],
    summary: "Cancel a running exec operation (its exact worker and descendants).",
    positionals: [{ name: "operation", required: true }],
    options: [REQUEST_ID_OPTION],
    idOutput: "operation ID",
    async run(context, parsed) {
      const { session, result, receipt, warnings } = await submit(
        context,
        "run.cancel",
        { operationId: parsed.positionals.operation },
        parsed.options,
      );
      return {
        action: "run.cancel",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: receipt ? [receipt.operationId] : [],
        human: receipt ? receiptLines(receipt) : ["cancel requested"],
      };
    },
  },
  {
    path: ["run", "output"],
    summary: "Read a bounded window of an exec operation's stdout or stderr.",
    positionals: [{ name: "operation", required: true }],
    options: [
      {
        name: "stream",
        kind: "string",
        valueName: "stdout|stderr",
        description: "Stream (default stdout).",
      },
      { name: "offset", kind: "integer", valueName: "BYTES", description: "Start offset." },
      {
        name: "tail",
        kind: "integer",
        valueName: "BYTES",
        description: "Read the last N bytes instead.",
      },
      {
        name: "max-bytes",
        kind: "integer",
        valueName: "BYTES",
        description: "Window size (max 256 KiB).",
      },
      {
        name: "raw",
        kind: "boolean",
        description: "Human mode: write the bytes verbatim to stdout.",
      },
    ],
    async run(context, parsed) {
      const options = parsed.options;
      if (options.offset !== undefined && options.tail !== undefined) {
        throw new CliError("invalid-input", "--offset and --tail are mutually exclusive");
      }
      const session = await context.session();
      const window = await session.read<PublicExecOutputWindow>("run.output", {
        operationId: parsed.positionals.operation,
        stream:
          options.stream === undefined
            ? "stdout"
            : oneOf(options.stream, ["stdout", "stderr"] as const, "--stream"),
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
        ...(options.tail !== undefined ? { tailBytes: options.tail } : {}),
        ...(options["max-bytes"] !== undefined ? { maxBytes: options["max-bytes"] } : {}),
      });
      if (context.global.output === "human" && options.raw === true) {
        context.io.stdout(window.text);
        return { action: "run.output", result: window, connection: session.identity, human: [] };
      }
      return {
        action: "run.output",
        result: window,
        connection: session.identity,
        human: [
          ...window.text.split("\n"),
          `-- ${window.stream} bytes ${window.offset}-${window.offset + Buffer.from(window.base64, "base64").byteLength} of ${window.totalBytes}${window.complete ? " (complete)" : ""}`,
        ],
      };
    },
  },
  {
    path: ["run", "receipts"],
    summary: "List this client's private local receipts (request keys it has sent).",
    description:
      "A local receipt records that a request was about to be sent; it is not proof the backend accepted it. Use `run get --request-id KEY --action ACTION` to reconcile.",
    positionals: [],
    options: [
      {
        name: "limit",
        kind: "integer",
        valueName: "N",
        description: "Most recent N (default 50).",
      },
    ],
    local: true,
    async run(context, parsed) {
      const receipts = await new LocalReceiptStore(context.configStore.receiptsDirectory).list(
        undefined,
        Math.max(1, Math.min(1000, (parsed.options.limit as number | undefined) ?? 50)),
      );
      return {
        action: "run.receipts",
        result: { items: receipts },
        human: table(
          ["REQUEST", "ACTION", "OPERATION", "STATE", "UPDATED"],
          receipts.map((receipt) => [
            receipt.requestId,
            receipt.action,
            receipt.operationId ?? "(no response)",
            receipt.state ?? "-",
            receipt.updatedAt,
          ]),
        ),
      };
    },
  },
];

export type { PublicReceipt };
