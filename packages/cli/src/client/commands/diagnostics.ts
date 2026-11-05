import type {
  DiagnosticsBundleChunk,
  DiagnosticsBundlePlan,
  DiagnosticsManifest,
} from "@orkestrator/protocol/backend-diagnostics";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../errors.js";
import { table } from "../format.js";
import type { CommandSpec } from "../spec.js";
import { stringOption } from "./common.js";

/**
 * `diagnostics …`: a local bundle a user can read and then attach to a report.
 * The bytes travel from the selected backend to this client and stop at the file
 * this writes; nothing here or there uploads them.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function manifestLines(manifest: DiagnosticsManifest): string[] {
  return [
    ...table(
      ["FILE", "SIZE", "REDACTED", "HOLDS"],
      manifest.entries.map((entry) => [
        entry.path,
        formatBytes(entry.bytes),
        String(entry.redactions),
        entry.description,
      ]),
    ),
    ...(manifest.absent.length > 0
      ? [
          "",
          "Not in the bundle:",
          ...manifest.absent.map((item) => `  ${item.name}: ${item.reason}`),
        ]
      : []),
    "",
    manifest.notice,
  ];
}

export const diagnosticsCommands: CommandSpec[] = [
  {
    path: ["diagnostics", "plan"],
    action: "diagnostics.plan",
    summary: "Show exactly what a diagnostics bundle would hold, without saving it.",
    description:
      "The backend builds the bundle in memory and answers with its manifest. Pass the printed plan ID to `diagnostics export --plan` to save that same bundle. A plan lasts 15 minutes.",
    positionals: [],
    options: [],
    idOutput: "the plan ID",
    async run(context) {
      const session = await context.session();
      const plan = await session.read<DiagnosticsBundlePlan>("diagnostics.plan", {});
      return {
        action: "diagnostics.plan",
        result: plan,
        connection: session.identity,
        ids: [plan.planId],
        human: [
          `Plan ${plan.planId}, ${formatBytes(plan.archive.bytes)}, until ${plan.expiresAt}`,
          "",
          ...manifestLines(plan.manifest),
        ],
      };
    },
  },
  {
    path: ["diagnostics", "export"],
    action: "diagnostics.read",
    inputFields: { plan: "planId", file: null },
    summary: "Save a diagnostics bundle (.tar.gz) on this machine. Nothing is uploaded.",
    description:
      "Metrics, health figures, database figures and logs, with credentials and home directories redacted by pattern. Redaction is not a proof, so read the files before sharing them. The bundle is written with owner-only permissions, and an existing file is never overwritten.",
    positionals: [],
    options: [
      {
        name: "file",
        kind: "string",
        valueName: "PATH",
        description: "File to write on this machine (default: a dated name in this directory).",
      },
      {
        name: "plan",
        kind: "string",
        valueName: "PLAN_ID",
        description: "Save a bundle you reviewed with `diagnostics plan` (default: plan one now).",
      },
    ],
    examples: [
      "orkestrator diagnostics export",
      "orkestrator diagnostics plan",
      "orkestrator diagnostics export --plan PLAN_ID --file report.tar.gz",
    ],
    async run(context, parsed) {
      const session = await context.session();
      const reviewedPlan = stringOption(parsed.options, "plan");
      const plan = reviewedPlan
        ? null
        : await session.read<DiagnosticsBundlePlan>("diagnostics.plan", {});
      const planId = reviewedPlan ?? plan!.planId;

      const pieces: Buffer[] = [];
      let offset: number | null = 0;
      let last: DiagnosticsBundleChunk | null = null;
      while (offset !== null) {
        last = await session.read<DiagnosticsBundleChunk>("diagnostics.read", { planId, offset });
        pieces.push(Buffer.from(last.data, "base64"));
        offset = last.nextOffset;
      }
      const bytes = Buffer.concat(pieces);
      const expected = last!.archive;
      if (
        bytes.byteLength !== expected.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== expected.sha256
      ) {
        throw new CliError(
          "operation-failed",
          "The bundle did not arrive intact; nothing was saved.",
          {
            retryable: true,
          },
        );
      }

      const target = path.resolve(
        context.io.cwd,
        stringOption(parsed.options, "file") ?? last!.fileName,
      );
      try {
        await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new CliError("invalid-input", "That file already exists; choose another --file.");
        }
        throw new CliError("operation-failed", "The bundle could not be written to that path.");
      }
      return {
        action: "diagnostics.read",
        result: {
          path: target,
          archive: expected,
          ...(plan ? { manifest: plan.manifest } : {}),
        },
        connection: session.identity,
        ids: [target],
        human: [
          `Saved ${target} (${formatBytes(bytes.byteLength)}). Nothing was uploaded.`,
          ...(plan ? ["", ...manifestLines(plan.manifest)] : []),
        ],
      };
    },
  },
];
