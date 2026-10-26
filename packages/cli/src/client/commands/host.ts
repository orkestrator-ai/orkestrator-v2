import {
  isHostUpdateChannel,
  type HostMaintenanceSnapshot,
} from "@orkestrator/protocol/host-maintenance";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import { CliError } from "../errors.js";
import type { ClientSession } from "../session.js";
import type { CommandContext, CommandSpec, OptionSpec } from "../spec.js";
import { observe, ObservationStopped } from "../wait.js";
import {
  DEFAULT_WAIT_MS,
  isTerminalReceipt,
  readOperation,
  receiptFailure,
  REQUEST_ID_OPTION,
  stringOption,
  submit,
  TIMEOUT_OPTION,
} from "./common.js";

/**
 * `host …`: maintain the computer running the selected backend — Orkestrator
 * updates (`update check | apply | cancel`), the pinned toolchain
 * (`toolchain repair`), gh's channel (`gh latest | pinned`) and the container
 * image (`image update`). Applying an update restarts that computer's app or
 * service, so the wait tolerates the backend going away and coming back.
 */

const WAIT_OPTION: OptionSpec = {
  name: "wait",
  kind: "boolean",
  description: "Observe until the check is answered or the update finishes.",
};

function hostLines(host: HostMaintenanceSnapshot): string[] {
  const updater = host.updater;
  const lines = [`Version: ${host.version}`, `Update channel: ${host.updateChannel}`];
  lines.push(
    updater.available
      ? `Updater: ${updater.kind}`
      : `Updater: unavailable${updater.reason ? ` (${updater.reason})` : ""}`,
  );
  if (updater.checkedAt) {
    const found = updater.latestVersion ?? "unknown";
    const verdict =
      updater.checkError !== null
        ? `check failed: ${updater.checkError}`
        : updater.updateAvailable
          ? "update available"
          : updater.updateAvailable === false
            ? "up to date"
            : "not checked since this version started";
    lines.push(`Latest: ${found} (${verdict}; checked ${updater.checkedAt})`);
  } else {
    lines.push("Latest: not checked yet");
  }
  if (host.checkRequest) lines.push(`Check: requested ${host.checkRequest.requestedAt}`);
  const job = host.job;
  if (job) {
    const target = job.targetVersion ?? job.requestedVersion ?? "newest";
    const detail =
      job.state === "downloading" && job.progressPercent !== null
        ? ` ${job.progressPercent}%`
        : job.state === "awaiting-restart" && job.restartAt
          ? ` until ${job.restartAt}`
          : job.error
            ? `: ${job.error}`
            : "";
    lines.push(`Update: ${job.fromVersion} → ${target} ${job.state}${detail} (${job.id})`);
  }
  if (host.impact) {
    const impact = host.impact;
    const inContainers =
      impact.containerTerminals !== undefined
        ? ` (${impact.containerTerminals} in containers)`
        : "";
    lines.push(
      `Running: ${impact.workingAgents} agents working, ${impact.waitingAgents} waiting, ${impact.activePipelines} pipelines, ${impact.terminals} terminals${inContainers}`,
    );
  }
  if (host.tools?.length) {
    lines.push("Tools:");
    for (const tool of host.tools) {
      const next = host.nextRelease?.tools[tool.name];
      const where =
        tool.source === "managed"
          ? (tool.installedVersion ?? tool.pinnedVersion)
          : tool.source === "path"
            ? "on PATH (not managed)"
            : "missing";
      lines.push(
        `  ${tool.name.padEnd(9)} pinned ${tool.pinnedVersion.padEnd(9)} host ${where}${
          tool.channel === "latest" ? " (newest release)" : ""
        }${next && next !== tool.pinnedVersion ? `  → ${next} in ${host.nextRelease!.version}` : ""}`,
      );
    }
  }
  if (host.image) {
    const image = host.image;
    lines.push(
      `Image: ${image.name} ${!image.present ? "not installed" : image.compatible ? "compatible" : "not compatible"}${
        image.outdatedEnvironments.length
          ? `; rebuild ${image.outdatedEnvironments.map((environment) => environment.name).join(", ")}`
          : ""
      }`,
    );
  }
  for (const task of Object.values(host.tasks ?? {})) {
    if (!task) continue;
    lines.push(
      `Task ${task.kind}: ${task.state}${task.stage ? ` (${task.stage})` : ""}${task.error ? `: ${task.error}` : ""}`,
    );
  }
  return lines;
}

function stopped(error: ObservationStopped, action: string, receipt?: PublicReceipt): CliError {
  return error.reason === "signal"
    ? new CliError("observation-interrupted", "Stopped observing; the host carries on", {
        action,
        ...(receipt ? { receipt } : {}),
        details: { signal: error.signalName ?? "SIGINT" },
      })
    : new CliError("deadline-exceeded", "Timed out observing; the host carries on", {
        action,
        ...(receipt ? { receipt } : {}),
      });
}

/**
 * The backend restarts during an update. Until it answers again the request is
 * refused, fails with the shutdown error, or meets a proxy's non-JSON 502
 * (Tailscale Serve); keep waiting through all three.
 */
function backendAway(error: unknown): boolean {
  return (
    error instanceof CliError &&
    (error.code === "connection-failed" || error.code === "response-invalid")
  );
}

function timeoutMs(options: Record<string, unknown>): number {
  if (options.timeout !== undefined && !options.wait) {
    throw new CliError("invalid-input", "--timeout needs --wait");
  }
  return typeof options.timeout === "number" ? options.timeout : DEFAULT_WAIT_MS;
}

async function readHost(session: ClientSession): Promise<HostMaintenanceSnapshot> {
  return session.read<HostMaintenanceSnapshot>("host.status", {});
}

/** Follows an operation to its end, through backend restarts. */
async function waitForReceipt(
  context: CommandContext,
  session: ClientSession,
  receipt: PublicReceipt,
  limit: number,
  action: string,
): Promise<PublicReceipt> {
  if (isTerminalReceipt(receipt)) return receipt;
  try {
    return await observe<PublicReceipt>(
      async () => {
        try {
          const current = await readOperation(session, receipt.operationId);
          return isTerminalReceipt(current)
            ? { done: true as const, value: current }
            : { done: false as const };
        } catch (error) {
          if (backendAway(error)) return { done: false as const };
          throw error;
        }
      },
      { timeoutMs: limit, signal: context.signal },
    );
  } catch (error) {
    if (error instanceof ObservationStopped) throw stopped(error, action, receipt);
    throw error;
  }
}

/** A dependency task: submit, optionally follow it, then show the host. */
function taskCommand(spec: {
  path: string[];
  action: "host.toolchain.repair" | "host.image.update" | "host.gh.update";
  summary: string;
  description?: string;
  input: Record<string, unknown>;
}): CommandSpec {
  return {
    path: spec.path,
    action: spec.action,
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    positionals: [],
    options: [WAIT_OPTION, TIMEOUT_OPTION, REQUEST_ID_OPTION],
    idOutput: "operation ID",
    async run(context, parsed) {
      const wait = parsed.options.wait === true;
      const limit = timeoutMs(parsed.options);
      const { session, result, receipt, warnings } = await submit<{ taskId: string }>(
        context,
        spec.action,
        spec.input,
        parsed.options,
      );
      const latest =
        wait && receipt
          ? await waitForReceipt(context, session, receipt, limit, spec.action)
          : receipt;
      const failure = latest && isTerminalReceipt(latest) ? receiptFailure(latest) : undefined;
      const host = wait ? await readHost(session).catch(() => null) : null;
      return {
        action: spec.action,
        result: { ...result, ...(host ? { host } : {}) },
        receipt: latest,
        warnings,
        connection: session.identity,
        ids: receipt ? [receipt.operationId] : [],
        human: [
          `Task ${result.taskId}: ${latest?.state ?? "accepted"}`,
          ...(host ? hostLines(host) : ["Follow it with `orkestrator host status`."]),
        ],
        ...(failure ? { failure } : {}),
      };
    },
  };
}

export const hostCommands: CommandSpec[] = [
  {
    path: ["host", "status"],
    action: "host.status",
    summary: "Show the Orkestrator version on the backend's computer, its updater and any update.",
    positionals: [],
    options: [],
    async run(context) {
      const session = await context.session();
      const host = await readHost(session);
      return {
        action: "host.status",
        result: host,
        connection: session.identity,
        human: hostLines(host),
      };
    },
  },
  {
    path: ["host", "update", "channel"],
    action: "host.update.channel",
    summary: "Choose the host's update channel: stable, beta or unstable.",
    positionals: [{ name: "channel", required: true, description: "stable, beta or unstable" }],
    options: [REQUEST_ID_OPTION],
    async run(context, parsed) {
      const channel = parsed.positionals.channel;
      if (!isHostUpdateChannel(channel))
        throw new CliError("invalid-input", "channel must be stable, beta or unstable");
      const { session, result, receipt, warnings } = await submit<{
        host: HostMaintenanceSnapshot;
      }>(context, "host.update.channel", { channel }, parsed.options);
      return {
        action: "host.update.channel",
        result,
        receipt,
        warnings,
        connection: session.identity,
        human: hostLines(result.host),
      };
    },
  },
  {
    path: ["host", "update", "check"],
    action: "host.update.check",
    summary: "Ask the backend's computer to check for an Orkestrator update.",
    positionals: [],
    options: [WAIT_OPTION, TIMEOUT_OPTION, REQUEST_ID_OPTION],
    async run(context, parsed) {
      const wait = parsed.options.wait === true;
      const limit = timeoutMs(parsed.options);
      const { session, result, receipt, warnings } = await submit<{
        checkRequestId: string | null;
        host: HostMaintenanceSnapshot;
      }>(context, "host.update.check", {}, parsed.options);
      let host = result.host;
      if (wait && result.checkRequestId) {
        const requestId = result.checkRequestId;
        try {
          host = await observe<HostMaintenanceSnapshot>(
            async () => {
              const latest = await readHost(session);
              return latest.checkRequest?.id === requestId
                ? { done: false as const }
                : { done: true as const, value: latest };
            },
            { timeoutMs: limit, signal: context.signal },
          );
        } catch (error) {
          if (error instanceof ObservationStopped) {
            throw stopped(error, "host.update.check", receipt);
          }
          throw error;
        }
      }
      return {
        action: "host.update.check",
        result: { ...result, host },
        receipt,
        warnings,
        connection: session.identity,
        human: hostLines(host),
      };
    },
  },
  {
    path: ["host", "update", "apply"],
    action: "host.update.apply",
    inputFields: {
      release: "version",
      yes: "confirm",
      "when-idle": "drain",
      "max-wait": "maxWaitSeconds",
    },
    summary:
      "Install an Orkestrator update on the backend's computer. It restarts there after a 60 s countdown.",
    description:
      "Someone at that computer can postpone the restart; the update then installs the next time the app quits. Restarting ends agent turns and terminals running on that computer; containers keep running.",
    positionals: [],
    options: [
      {
        name: "release",
        kind: "string",
        valueName: "VERSION",
        description: "Install only this release; fail if the newest release is another one.",
      },
      {
        name: "yes",
        kind: "boolean",
        description: "Confirm that the host may restart. Required.",
      },
      {
        name: "when-idle",
        kind: "boolean",
        description:
          "Restart only once no agent turn or pipeline is running on the host (see --max-wait).",
      },
      {
        name: "max-wait",
        kind: "duration",
        valueName: "DURATION",
        description: "With --when-idle: restart anyway after this long (1m–24h). Default 1h.",
      },
      WAIT_OPTION,
      TIMEOUT_OPTION,
      REQUEST_ID_OPTION,
    ],
    idOutput: "operation ID",
    async run(context: CommandContext, parsed) {
      if (parsed.options.yes !== true) {
        throw new CliError(
          "invalid-input",
          "Installing restarts Orkestrator on the backend's computer; pass --yes to confirm",
        );
      }
      const wait = parsed.options.wait === true;
      const limit = timeoutMs(parsed.options);
      const version = stringOption(parsed.options, "release");
      const whenIdle = parsed.options["when-idle"] === true;
      const maxWait = parsed.options["max-wait"];
      if (maxWait !== undefined && !whenIdle) {
        throw new CliError("invalid-input", "--max-wait needs --when-idle");
      }
      const { session, result, receipt, warnings } = await submit<{
        jobId: string;
        fromVersion: string;
        version?: string | null;
      }>(
        context,
        "host.update.apply",
        {
          confirm: true,
          ...(version ? { version } : {}),
          ...(whenIdle ? { drain: "when-idle" } : {}),
          ...(typeof maxWait === "number" ? { maxWaitSeconds: Math.round(maxWait / 1000) } : {}),
        },
        parsed.options,
      );
      const latest =
        wait && receipt
          ? await waitForReceipt(context, session, receipt, limit, "host.update.apply")
          : receipt;
      const failure = latest && isTerminalReceipt(latest) ? receiptFailure(latest) : undefined;
      const host = wait ? await readHost(session).catch(() => null) : null;
      const human = [
        `Update ${result.jobId}: ${latest?.state ?? "accepted"} (${latest?.stage ?? ""})`,
      ];
      if (host) human.push(...hostLines(host));
      else if (!wait) human.push("Follow it with `orkestrator host status`.");
      return {
        action: "host.update.apply",
        result: { ...result, ...(host ? { host } : {}) },
        receipt: latest,
        warnings,
        connection: session.identity,
        ids: receipt ? [receipt.operationId] : [],
        human,
        ...(failure ? { failure } : {}),
      };
    },
  },
  {
    path: ["host", "update", "cancel"],
    action: "host.update.cancel",
    summary: "Cancel the host's update before it restarts.",
    positionals: [],
    options: [REQUEST_ID_OPTION],
    async run(context, parsed) {
      const { session, result, receipt, warnings } = await submit<{ jobId: string }>(
        context,
        "host.update.cancel",
        {},
        parsed.options,
      );
      return {
        action: "host.update.cancel",
        result,
        receipt,
        warnings,
        connection: session.identity,
        human: [`Cancelled update ${result.jobId}.`],
      };
    },
  },
  taskCommand({
    path: ["host", "toolchain", "repair"],
    action: "host.toolchain.repair",
    summary: "Reinstall whatever of the host's pinned agent tools is missing or fails its digest.",
    input: {},
  }),
  taskCommand({
    path: ["host", "image", "update"],
    action: "host.image.update",
    summary:
      "Pull the release container image matching the backend and use it for new environments.",
    description:
      "Running environments keep their image; `host status` lists those to rebuild afterwards.",
    input: {},
  }),
  taskCommand({
    path: ["host", "gh", "latest"],
    action: "host.gh.update",
    summary: "Make the host use the newest gh release instead of its pin (unqualified).",
    input: { channel: "latest" },
  }),
  taskCommand({
    path: ["host", "gh", "pinned"],
    action: "host.gh.update",
    summary: "Make the host use the gh this Orkestrator release pins.",
    input: { channel: "pinned" },
  }),
];
