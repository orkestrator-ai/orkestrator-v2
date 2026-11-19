import {
  approveCredentialRequestCommand,
  createCredentialConnectionCommand,
  declineCredentialRequestCommand,
  deleteCredentialConnectionCommand,
  getCredentialOverviewCommand,
  getCredentialSnapshotCommand,
  replaceCredentialConnectionValueCommand,
  revokeCredentialGrantCommand,
  updateCredentialConnectionCommand,
} from "@orkestrator/protocol/contract/domains/config";
import { CredentialError } from "@orkestrator/protocol/agent-credentials";
import type { CommandContext } from "./commands-context.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import type { CredentialService } from "./credentials/index.js";

/**
 * Agent credential commands (docs/architecture/agent-credentials.md): what a
 * person does in Settings and on the in-task card.
 *
 * There is no command that reads a value back. The commands that take one
 * (`approve_credential_request` with a value source,
 * `create_credential_connection`, `replace_credential_connection_value`) pass
 * it straight to the credential service; their answers are metadata, and
 * their errors are `CredentialError`s, which name the problem and never the
 * input. No public action, Control MCP tool or coordinator tool maps onto the
 * human-only ones (`CREDENTIAL_HUMAN_ONLY_COMMANDS`).
 */

function service(context: CommandContext): CredentialService {
  if (!context.credentials) {
    throw new CredentialError(
      "STORE_UNAVAILABLE",
      "Agent credentials are not available on this backend.",
    );
  }
  return context.credentials;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function registerCredentialCommands(register: CommandRegistrar): void {
  register(getCredentialSnapshotCommand, (args, context) =>
    service(context).tabSnapshot({
      environmentId: args.environmentId,
      ...(args.tabId ? { tabId: args.tabId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    }),
  );

  register(getCredentialOverviewCommand, (_args, context) => service(context).overview());

  register(
    approveCredentialRequestCommand,
    async (args, context) =>
      service(context).approve({
        requestId: args.requestId,
        revision: args.revision,
        source: args.source,
        ...(args.lifetimeMs !== undefined ? { lifetimeMs: args.lifetimeMs } : {}),
        ...(args.maxUses !== undefined ? { maxUses: args.maxUses } : {}),
        ...(args.hosts !== undefined ? { hosts: args.hosts } : {}),
      }),
    ASYNC_HANDLER,
  );

  register(declineCredentialRequestCommand, (args, context) => ({
    request: service(context).decline({ requestId: args.requestId, revision: args.revision }),
  }));

  register(revokeCredentialGrantCommand, (args, context) => ({
    grant: service(context).revokeGrant(args.grantId),
  }));

  register(
    createCredentialConnectionCommand,
    async (args, context) =>
      service(context).createConnection({
        name: args.name,
        ...(args.description !== undefined ? { description: args.description } : {}),
        value: args.value,
        ...(args.projectIds !== undefined
          ? { projectIds: args.projectIds as string[] | null }
          : {}),
        ...(args.httpHosts !== undefined ? { httpHosts: args.httpHosts as string[] } : {}),
      }),
    ASYNC_HANDLER,
  );

  register(updateCredentialConnectionCommand, (args, context) =>
    service(context).updateConnection({
      id: args.id,
      revision: args.revision,
      ...(optionalString(args.name) !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.projectIds !== undefined ? { projectIds: args.projectIds as string[] | null } : {}),
      ...(args.httpHosts !== undefined ? { httpHosts: args.httpHosts as string[] } : {}),
    }),
  );

  register(
    replaceCredentialConnectionValueCommand,
    async (args, context) =>
      service(context).replaceConnectionValue({ id: args.id, value: args.value }),
    ASYNC_HANDLER,
  );

  register(
    deleteCredentialConnectionCommand,
    async (args, context) => service(context).deleteConnection(args.id),
    ASYNC_HANDLER,
  );
}
