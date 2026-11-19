/**
 * `config` commands for agent credentials (docs/architecture/agent-credentials.md):
 * saved connections, the person's decisions on an agent's access request, and
 * the reads behind the in-task card and Settings.
 *
 * `access`:
 * - `admin` for every command that puts a value into the backend or hands a
 *   saved one to an agent (approving a request, creating or replacing a
 *   connection), and for changing or deleting a connection. A client grant
 *   and the node relay run only `workspace` commands, so a short-lived
 *   workspace grant cannot do these. The coordinator invoker also refuses
 *   them (`control-mcp/server.ts`), and no Control MCP tool or public action
 *   reaches them.
 * - `workspace` for the reads, which are metadata, and for revoking a grant,
 *   which only takes access away.
 *
 * Arguments that carry a value (`source`, `value`) are `Unknown`: the handler
 * validates them without echoing them, so a decode failure can never quote a
 * value in an error.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type {
  CredentialConnection,
  CredentialGrantRecord,
  CredentialOperationRecord,
  CredentialRequestRecord,
} from "../../../agent-credentials.js";
import { defineCommand } from "../../command.js";
import { modelRecord, mutableArray } from "../../model-schema.js";
import { configDomain } from "./domain.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const optionalString = Schema.optionalKey(Schema.String);

const CredentialVaultStatusSchema = Schema.Struct({
  durable: Schema.Literals(["keychain", "file", "memory"]),
  canSave: Schema.Boolean,
  detail: Schema.String,
});

export const CredentialConnectionSchema = modelRecord<CredentialConnection>()({
  id: Schema.String,
  name: Schema.String,
  revision: Schema.Finite,
  valueVersion: Schema.Finite,
});

export const CredentialRequestSchema = modelRecord<CredentialRequestRecord>()({
  id: Schema.String,
  revision: Schema.Finite,
  environmentId: Schema.String,
  tabId: Schema.String,
  state: Schema.String,
});

export const CredentialGrantSchema = modelRecord<CredentialGrantRecord>()({
  id: Schema.String,
  environmentId: Schema.String,
  tabId: Schema.String,
  state: Schema.String,
});

export const CredentialOperationSchema = modelRecord<CredentialOperationRecord>()({
  id: Schema.String,
  grantId: Schema.String,
  state: Schema.String,
});

export const CredentialTabSnapshotSchema = Schema.Struct({
  requests: mutableArray(CredentialRequestSchema),
  grants: mutableArray(CredentialGrantSchema),
  connections: mutableArray(CredentialConnectionSchema),
  vault: CredentialVaultStatusSchema,
});

export const CredentialOverviewSchema = Schema.Struct({
  vault: CredentialVaultStatusSchema,
  connections: mutableArray(CredentialConnectionSchema),
  grants: mutableArray(CredentialGrantSchema),
  operations: mutableArray(CredentialOperationSchema),
});

/** One environment's (or tab's) credential requests and grants, for the in-task card. */
export const getCredentialSnapshotCommand = defineCommand({
  domain: configDomain,
  name: "get_credential_snapshot",
  since: 2,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
    tabId: optionalString,
    projectId: optionalString,
  }),
  result: CredentialTabSnapshotSchema,
  critical: [],
});

/** Every saved connection, active grant and recent operation on this machine. */
export const getCredentialOverviewCommand = defineCommand({
  domain: configDomain,
  name: "get_credential_overview",
  since: 2,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: CredentialOverviewSchema,
  critical: [],
});

/**
 * The person approves one revision of a request. `source` is a saved
 * connection or a value (optionally saved). `hosts` narrows an HTTP grant's
 * destinations; `lifetimeMs` and `maxUses` bound it. All three are critical:
 * a receiver that ignored them would grant more than the person chose.
 */
export const approveCredentialRequestCommand = defineCommand({
  domain: configDomain,
  name: "approve_credential_request",
  since: 2,
  access: "admin",
  read: false,
  args: Schema.Struct({
    requestId: Schema.String,
    revision: Schema.Finite,
    source: Schema.Unknown,
    lifetimeMs: optionalUnknown,
    maxUses: optionalUnknown,
    hosts: optionalUnknown,
  }),
  result: Schema.Struct({ request: CredentialRequestSchema, grant: CredentialGrantSchema }),
  critical: ["lifetimeMs", "maxUses", "hosts"],
});

export const declineCredentialRequestCommand = defineCommand({
  domain: configDomain,
  name: "decline_credential_request",
  since: 2,
  access: "admin",
  read: false,
  args: Schema.Struct({ requestId: Schema.String, revision: Schema.Finite }),
  result: Schema.Struct({ request: CredentialRequestSchema }),
  critical: [],
});

/** Ends a grant at once; running work of it is stopped. */
export const revokeCredentialGrantCommand = defineCommand({
  domain: configDomain,
  name: "revoke_credential_grant",
  since: 2,
  access: "workspace",
  read: false,
  args: Schema.Struct({ grantId: Schema.String }),
  result: Schema.Struct({ grant: Schema.NullOr(CredentialGrantSchema) }),
  critical: [],
});

export const createCredentialConnectionCommand = defineCommand({
  domain: configDomain,
  name: "create_credential_connection",
  since: 2,
  access: "admin",
  read: false,
  args: Schema.Struct({
    name: Schema.String,
    description: optionalString,
    value: Schema.Unknown,
    projectIds: optionalUnknown,
    httpHosts: optionalUnknown,
  }),
  result: CredentialConnectionSchema,
  critical: ["projectIds", "httpHosts"],
});

/** Name, description or policy. A policy change ends the connection's grants. */
export const updateCredentialConnectionCommand = defineCommand({
  domain: configDomain,
  name: "update_credential_connection",
  since: 2,
  access: "admin",
  read: false,
  args: Schema.Struct({
    id: Schema.String,
    revision: Schema.Finite,
    name: optionalString,
    description: optionalString,
    projectIds: optionalUnknown,
    httpHosts: optionalUnknown,
  }),
  result: CredentialConnectionSchema,
  critical: ["projectIds", "httpHosts"],
});

/** Replaces the value; grants that pinned the old one end. */
export const replaceCredentialConnectionValueCommand = defineCommand({
  domain: configDomain,
  name: "replace_credential_connection_value",
  since: 2,
  access: "admin",
  read: false,
  args: Schema.Struct({ id: Schema.String, value: Schema.Unknown }),
  result: CredentialConnectionSchema,
  critical: [],
});

export const deleteCredentialConnectionCommand = defineCommand({
  domain: configDomain,
  name: "delete_credential_connection",
  since: 2,
  access: "admin",
  read: false,
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.Struct({
    deleted: Schema.Boolean,
    cleanupPending: Schema.optionalKey(Schema.Boolean),
  }),
  critical: [],
});

export const CREDENTIAL_COMMANDS = [
  getCredentialSnapshotCommand,
  getCredentialOverviewCommand,
  approveCredentialRequestCommand,
  declineCredentialRequestCommand,
  revokeCredentialGrantCommand,
  createCredentialConnectionCommand,
  updateCredentialConnectionCommand,
  replaceCredentialConnectionValueCommand,
  deleteCredentialConnectionCommand,
] as const;

/** Commands a coordinator (or anything acting for an agent) must never reach. */
export const CREDENTIAL_HUMAN_ONLY_COMMANDS = [
  approveCredentialRequestCommand.name,
  declineCredentialRequestCommand.name,
  createCredentialConnectionCommand.name,
  updateCredentialConnectionCommand.name,
  replaceCredentialConnectionValueCommand.name,
  deleteCredentialConnectionCommand.name,
] as const;
