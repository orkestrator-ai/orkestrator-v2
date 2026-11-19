import type {
  CredentialConnection,
  CredentialGrantRecord,
  CredentialOverview,
  CredentialRequestRecord,
  CredentialTabSnapshot,
} from "@orkestrator/protocol/agent-credentials";
import { type AccountMachine } from "./agent-accounts";
import { config as configDomain } from "@/lib/node-scope/domains/config";
import {
  commandBackendClient,
  type BackendClient,
  machineBackendClient,
  withArgumentsObject,
} from "./client";

/**
 * Agent credentials (docs/architecture/agent-credentials.md). The card in an
 * agent tab reads its tab's requests and approves or declines them; Settings
 * manages saved connections and active grants per machine.
 *
 * Values travel only in `approveCredentialRequest` (a value source) and the
 * connection create/replace calls, straight from a form's local state. None
 * of these functions logs, caches or returns a value.
 *
 * The approval and connection writes are `admin` commands: on a node the
 * window does not run on, they go through the command node
 * (`machineBackendClient`), since a node's own workspace scope refuses them.
 */

export interface CredentialApprovalChoice {
  requestId: string;
  revision: number;
  source:
    | { kind: "connection"; connectionId: string }
    | { kind: "value"; value: string; saveAs?: { name: string; description?: string } };
  lifetimeMs: number;
  maxUses?: number;
  hosts?: string[];
}

export interface CredentialConnectionInput {
  name: string;
  description?: string;
  projectIds: string[] | null;
  httpHosts: string[];
}

export function createCredentialsApi(client: BackendClient) {
  const own = configDomain(withArgumentsObject(client));
  const on = (machine: AccountMachine | undefined) =>
    machine === undefined ? own() : configDomain(machineBackendClient(client, machine))();

  function getCredentialSnapshot(
    input: { environmentId: string; tabId?: string; projectId?: string },
    machine?: AccountMachine,
  ): Promise<CredentialTabSnapshot> {
    return on(machine).get_credential_snapshot(input) as Promise<CredentialTabSnapshot>;
  }

  function getCredentialOverview(machine?: AccountMachine): Promise<CredentialOverview> {
    return on(machine).get_credential_overview({}) as Promise<CredentialOverview>;
  }

  function approveCredentialRequest(
    choice: CredentialApprovalChoice,
    machine?: AccountMachine,
  ): Promise<{ request: CredentialRequestRecord; grant: CredentialGrantRecord }> {
    return on(machine).approve_credential_request({
      requestId: choice.requestId,
      revision: choice.revision,
      source: choice.source,
      lifetimeMs: choice.lifetimeMs,
      ...(choice.maxUses !== undefined ? { maxUses: choice.maxUses } : {}),
      ...(choice.hosts !== undefined ? { hosts: choice.hosts } : {}),
    }) as Promise<{ request: CredentialRequestRecord; grant: CredentialGrantRecord }>;
  }

  function declineCredentialRequest(
    input: { requestId: string; revision: number },
    machine?: AccountMachine,
  ): Promise<{ request: CredentialRequestRecord }> {
    return on(machine).decline_credential_request(input) as Promise<{
      request: CredentialRequestRecord;
    }>;
  }

  function revokeCredentialGrant(
    grantId: string,
    machine?: AccountMachine,
  ): Promise<{ grant: CredentialGrantRecord | null }> {
    return on(machine).revoke_credential_grant({ grantId }) as Promise<{
      grant: CredentialGrantRecord | null;
    }>;
  }

  function createCredentialConnection(
    input: CredentialConnectionInput & { value: string },
    machine?: AccountMachine,
  ): Promise<CredentialConnection> {
    return on(machine).create_credential_connection({
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      value: input.value,
      projectIds: input.projectIds,
      httpHosts: input.httpHosts,
    }) as Promise<CredentialConnection>;
  }

  function updateCredentialConnection(
    input: { id: string; revision: number } & Partial<CredentialConnectionInput>,
    machine?: AccountMachine,
  ): Promise<CredentialConnection> {
    return on(machine).update_credential_connection({
      id: input.id,
      revision: input.revision,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.projectIds !== undefined ? { projectIds: input.projectIds } : {}),
      ...(input.httpHosts !== undefined ? { httpHosts: input.httpHosts } : {}),
    }) as Promise<CredentialConnection>;
  }

  function replaceCredentialConnectionValue(
    input: { id: string; value: string },
    machine?: AccountMachine,
  ): Promise<CredentialConnection> {
    return on(machine).replace_credential_connection_value(input) as Promise<CredentialConnection>;
  }

  function deleteCredentialConnection(
    id: string,
    machine?: AccountMachine,
  ): Promise<{ deleted: boolean }> {
    return on(machine).delete_credential_connection({ id });
  }

  return {
    getCredentialSnapshot,
    getCredentialOverview,
    approveCredentialRequest,
    declineCredentialRequest,
    revokeCredentialGrant,
    createCredentialConnection,
    updateCredentialConnection,
    replaceCredentialConnectionValue,
    deleteCredentialConnection,
  };
}

export type CredentialsApi = ReturnType<typeof createCredentialsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getCredentialSnapshot,
  getCredentialOverview,
  approveCredentialRequest,
  declineCredentialRequest,
  revokeCredentialGrant,
  createCredentialConnection,
  updateCredentialConnection,
  replaceCredentialConnectionValue,
  deleteCredentialConnection,
} = createCredentialsApi(commandBackendClient);
