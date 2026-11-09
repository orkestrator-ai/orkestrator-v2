/**
 * What the backend holds about the host OpenCode 2.x servers it started
 * (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 3): one per
 * local environment, under the process key `opencode2:<environmentId>` in
 * `LocalServerRuntime`'s owned processes, so backend shutdown stops them with
 * every other local server.
 *
 * The password is minted per server and lives only here, in process memory:
 * it is never written to the environment record, logged or sent to a
 * renderer. Starts are serialized per environment by the environment
 * operation queue, and host-wide by {@link OpenCode2HostServerState.startGate},
 * because every host 2.x server shares one `OPENCODE_DB` and 2.x migrates it
 * on start.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { OpenCodeHostStartGate } from "../opencode-host-start.js";
import type { OpenCode2CoordinatorAuthority } from "./coordinator.js";

export interface OpenCode2HostServerRecord {
  child: ChildProcessWithoutNullStreams;
  port: number;
  password: string;
  directory: string;
  /**
   * A coordinator's server only: the policy and research it was launched
   * with (`opencode2/coordinator.ts`). Process authority, held here beside
   * the process rather than in any session record.
   */
  coordinator?: Omit<OpenCode2CoordinatorAuthority, "controlConnection">;
}

export function openCode2ServerKey(environmentId: string): string {
  return `opencode2:${environmentId}`;
}

export class OpenCode2HostServerState {
  /** One 2.x start at a time on this host. */
  readonly startGate = new OpenCodeHostStartGate([]);
  private readonly servers = new Map<string, OpenCode2HostServerRecord>();

  /** The healthy record for this environment's live child, if any. */
  get(environmentId: string): OpenCode2HostServerRecord | undefined {
    const record = this.servers.get(environmentId);
    if (!record) return undefined;
    if (record.child.exitCode !== null || record.child.signalCode !== null) {
      this.servers.delete(environmentId);
      return undefined;
    }
    return record;
  }

  /** Every live record, by environment; they all share one `OPENCODE_DB`. */
  live(): Array<[string, OpenCode2HostServerRecord]> {
    return Array.from(this.servers.keys()).flatMap((environmentId) => {
      const record = this.get(environmentId);
      return record ? [[environmentId, record] as [string, OpenCode2HostServerRecord]] : [];
    });
  }

  record(environmentId: string, record: OpenCode2HostServerRecord): void {
    this.servers.set(environmentId, record);
  }

  /** Forget `child`'s record, unless a replacement already owns the environment. */
  forget(environmentId: string, child?: ChildProcessWithoutNullStreams): void {
    const record = this.servers.get(environmentId);
    if (record && (!child || record.child === child)) this.servers.delete(environmentId);
  }
}
