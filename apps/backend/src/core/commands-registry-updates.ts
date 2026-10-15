/**
 * The update protocol's backend commands. Client commands (`update_*`) are
 * reachable from the local renderer, any remote client holding the gateway
 * token, and the CLI: the same trust boundary that already lets those clients
 * run agents. Every mutation is audited on this machine with the trusted
 * invocation origin. Host commands (`update_host_*`) are accepted only on the
 * loopback control listener, so a remote client can never impersonate the
 * installer or fake an install outcome.
 */
import type {
  UpdateClientInfo,
  UpdateHostOutcome,
  UpdateHostRegistration,
  UpdateHostReport,
  UpdateRequester,
  UpdateStartArgs,
} from "@orkestrator/protocol/updates";
import type { CommandContext, InvocationOrigin } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { assertOnlyKeys } from "./commands-validation.js";
import { UpdateCommandError, type UpdateService } from "./updates/update-service.js";

const MAX_CONSENT_IDS = 256;
const MAX_ID_CHARS = 200;

function service(context: CommandContext): UpdateService {
  if (!context.updates)
    throw new UpdateCommandError("updates-disabled", "Updates are not available");
  return context.updates;
}

function invalid(message: string): never {
  throw new UpdateCommandError("invalid-request", message);
}

function boundedString(value: unknown, name: string, max = MAX_ID_CHARS): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    invalid(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function optionalString(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return boundedString(value, name, max);
}

/** What the client says about itself; recorded as declared, never trusted. */
export function parseClientInfo(value: unknown): UpdateClientInfo | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) invalid("client must be an object");
  const record = value as Record<string, unknown>;
  assertOnlyKeys(record, ["kind", "version", "name"], "client");
  const kind = record.kind;
  if (kind !== "desktop" && kind !== "web" && kind !== "cli" && kind !== "other") {
    invalid("client.kind must be desktop, web, cli or other");
  }
  return {
    kind,
    version: optionalString(record.version, "client.version", 64),
    name: optionalString(record.name, "client.name", 120),
  };
}

export function requesterFrom(
  origin: InvocationOrigin | undefined,
  client: UpdateClientInfo | null,
): UpdateRequester {
  if (!origin) {
    return {
      listener: "internal",
      remoteAddress: null,
      tailscaleUser: null,
      identitySource: "local",
      client,
    };
  }
  return {
    listener: origin.listener,
    remoteAddress: origin.remoteAddress,
    tailscaleUser: origin.tailscaleUser,
    identitySource: origin.tailscaleUser
      ? "tailscale-serve"
      : origin.listener === "control"
        ? "local"
        : "client-declared",
    client,
  };
}

/** Host commands come from this machine's installer: the loopback control listener, or in-process. */
function assertHostOrigin(origin: InvocationOrigin | undefined): void {
  if (origin && origin.listener !== "control") {
    throw new UpdateCommandError("forbidden", "Installer commands are only accepted locally");
  }
}

function parseStartArgs(args: Record<string, unknown>): UpdateStartArgs {
  assertOnlyKeys(
    args,
    [
      "targetVersion",
      "requirementsSha256",
      "approvedConsentIds",
      "restartPolicy",
      "allowDowngrade",
      "client",
    ],
    "arguments",
  );
  const approved = args.approvedConsentIds;
  if (
    !Array.isArray(approved) ||
    approved.length > MAX_CONSENT_IDS ||
    approved.some((id) => typeof id !== "string" || id.length === 0 || id.length > MAX_ID_CHARS)
  ) {
    invalid(`approvedConsentIds must be at most ${MAX_CONSENT_IDS} ids`);
  }
  if (args.restartPolicy !== "immediate" && args.restartPolicy !== "manual") {
    invalid("restartPolicy must be immediate or manual");
  }
  const sha = boundedString(args.requirementsSha256, "requirementsSha256", 64);
  if (!/^[0-9a-f]{64}$/.test(sha)) invalid("requirementsSha256 must be a SHA-256");
  if (args.allowDowngrade !== undefined && typeof args.allowDowngrade !== "boolean") {
    invalid("allowDowngrade must be a boolean");
  }
  return {
    targetVersion: boundedString(args.targetVersion, "targetVersion", 128),
    requirementsSha256: sha,
    approvedConsentIds: approved as string[],
    restartPolicy: args.restartPolicy,
    allowDowngrade: args.allowDowngrade === true,
    client: parseClientInfo(args.client) ?? undefined,
  };
}

function parseRegistration(value: unknown): UpdateHostRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("registration must be an object");
  }
  const record = value as Record<string, unknown>;
  assertOnlyKeys(
    record,
    [
      "hostKind",
      "protocolVersion",
      "hostVersion",
      "installKind",
      "capabilities",
      "unavailableReason",
      "armedJobId",
    ],
    "registration",
  );
  if (record.hostKind !== "desktop" && record.hostKind !== "supervisor") {
    invalid("hostKind must be desktop or supervisor");
  }
  if (
    record.installKind !== "mac-app" &&
    record.installKind !== "appimage" &&
    record.installKind !== "npm-package"
  ) {
    invalid("installKind is not recognised");
  }
  if (typeof record.protocolVersion !== "number" || !Number.isInteger(record.protocolVersion)) {
    invalid("protocolVersion must be an integer");
  }
  const capabilities = record.capabilities as Record<string, unknown> | undefined;
  if (
    !capabilities ||
    typeof capabilities.install !== "boolean" ||
    typeof capabilities.rollback !== "boolean" ||
    !Array.isArray(capabilities.restart) ||
    !capabilities.restart.every((entry) => entry === "now" || entry === "on-quit")
  ) {
    invalid("capabilities are malformed");
  }
  return {
    hostKind: record.hostKind,
    protocolVersion: record.protocolVersion,
    hostVersion: boundedString(record.hostVersion, "hostVersion", 128),
    installKind: record.installKind,
    capabilities: {
      install: capabilities.install as boolean,
      rollback: capabilities.rollback as boolean,
      restart: capabilities.restart as Array<"now" | "on-quit">,
    },
    unavailableReason: optionalString(record.unavailableReason, "unavailableReason", 500),
    armedJobId: optionalString(record.armedJobId, "armedJobId", MAX_ID_CHARS),
  };
}

function parseError(value: unknown): { code: string; message: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("error must be an object");
  }
  const record = value as Record<string, unknown>;
  assertOnlyKeys(record, ["code", "message"], "error");
  return {
    code: boundedString(record.code, "error.code", 64),
    message: boundedString(record.message, "error.message", 2000),
  };
}

function parseReport(args: Record<string, unknown>): UpdateHostReport {
  assertOnlyKeys(
    args,
    ["hostSessionId", "requestId", "jobId", "status", "progress", "error"],
    "arguments",
  );
  if (args.status !== "progress" && args.status !== "succeeded" && args.status !== "failed") {
    invalid("status must be progress, succeeded or failed");
  }
  let progress: UpdateHostReport["progress"];
  if (args.progress !== undefined) {
    const record = args.progress as Record<string, unknown>;
    if (typeof record !== "object" || record === null) invalid("progress must be an object");
    assertOnlyKeys(record, ["percent", "message"], "progress");
    const percent = record.percent;
    if (percent !== null && (typeof percent !== "number" || !Number.isFinite(percent))) {
      invalid("progress.percent must be a number or null");
    }
    progress = {
      percent: percent as number | null,
      message: optionalString(record.message, "progress.message", 500),
    };
  }
  return {
    hostSessionId: boundedString(args.hostSessionId, "hostSessionId"),
    requestId: boundedString(args.requestId, "requestId"),
    jobId: boundedString(args.jobId, "jobId"),
    status: args.status,
    progress,
    error: parseError(args.error),
  };
}

function parseOutcome(args: Record<string, unknown>): UpdateHostOutcome {
  assertOnlyKeys(
    args,
    ["hostSessionId", "jobId", "outcome", "error", "rollbackFailed"],
    "arguments",
  );
  if (args.outcome !== "succeeded" && args.outcome !== "rolled-back" && args.outcome !== "failed") {
    invalid("outcome must be succeeded, rolled-back or failed");
  }
  if (args.rollbackFailed !== undefined && typeof args.rollbackFailed !== "boolean") {
    invalid("rollbackFailed must be a boolean");
  }
  return {
    hostSessionId: boundedString(args.hostSessionId, "hostSessionId"),
    jobId: boundedString(args.jobId, "jobId"),
    outcome: args.outcome,
    error: parseError(args.error),
    rollbackFailed: args.rollbackFailed === true,
  };
}

export function registerUpdateCommands(register: CommandRegistrar): void {
  register("update_get_status", (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return service(context).snapshot();
  });
  register("update_check", (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return service(context).check();
  });
  register("update_set_channel", (args, context, origin) => {
    assertOnlyKeys(args, ["channel", "client"], "arguments");
    return service(context).setChannel(
      args.channel,
      requesterFrom(origin, parseClientInfo(args.client)),
    );
  });
  register("update_start", (args, context, origin) => {
    const parsed = parseStartArgs(args);
    return service(context).startJob(parsed, requesterFrom(origin, parsed.client ?? null));
  });
  register("update_install_now", (args, context, origin) => {
    assertOnlyKeys(args, ["jobId", "client"], "arguments");
    return service(context).installNow(
      args.jobId,
      requesterFrom(origin, parseClientInfo(args.client)),
    );
  });
  register("update_install_on_quit", (args, context, origin) => {
    assertOnlyKeys(args, ["jobId", "client"], "arguments");
    return service(context).installOnQuit(
      args.jobId,
      requesterFrom(origin, parseClientInfo(args.client)),
    );
  });
  register("update_cancel", (args, context, origin) => {
    assertOnlyKeys(args, ["jobId", "client"], "arguments");
    return service(context).cancel(args.jobId, requesterFrom(origin, parseClientInfo(args.client)));
  });
  register("update_acknowledge_notice", (args, context) => {
    assertOnlyKeys(args, ["noticeId"], "arguments");
    return service(context).acknowledgeNotice(args.noticeId);
  });
  register("update_get_audit", (args, context) => {
    assertOnlyKeys(args, ["limit"], "arguments");
    const limit = args.limit === undefined ? 50 : args.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      invalid("limit must be an integer from 1 to 200");
    }
    return service(context).auditLog(limit);
  });

  register("update_host_register", (args, context, origin) => {
    assertHostOrigin(origin);
    assertOnlyKeys(args, ["registration"], "arguments");
    return service(context).registerHost(parseRegistration(args.registration));
  });
  register("update_host_pending", (args, context, origin) => {
    assertHostOrigin(origin);
    assertOnlyKeys(args, ["hostSessionId"], "arguments");
    const updates = service(context);
    updates.host.assertSession(boundedString(args.hostSessionId, "hostSessionId"));
    return updates.host.pending();
  });
  register("update_host_report", (args, context, origin) => {
    assertHostOrigin(origin);
    service(context).hostReport(parseReport(args));
    return { ok: true };
  });
  register("update_host_outcome", (args, context, origin) => {
    assertHostOrigin(origin);
    return service(context).hostOutcome(parseOutcome(args));
  });
}
