/**
 * What the backend holds about the host OpenCode servers it started: one per
 * local environment or coordinator runtime, under the process key
 * `opencode:<environmentId>` in `LocalServerRuntime`'s owned processes, so
 * backend shutdown stops them with every other local server.
 *
 * The password is minted per server and lives only in process memory (here
 * and as the bridge token): it is never written to the environment record,
 * logged or sent to a renderer. Starts are serialized per environment by the
 * environment operation queue, and host-wide by
 * {@link OpenCode2HostServerState.startGate}, because every host server
 * shares one `OPENCODE_DB` and OpenCode migrates it on start.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { OpenCode2CoordinatorAuthority } from "./coordinator.js";
import type { OpenCode2McpConnection } from "./mcp.js";

export interface OpenCode2HostServerRecord {
  child: ChildProcessWithoutNullStreams;
  port: number;
  password: string;
  directory: string;
  /**
   * A coordinator's server only: the policy and research it was launched
   * with (`opencode2/coordinator.ts`), and the Control MCP credential the
   * launch issued, which its exit revokes. Process authority, held here
   * beside the process rather than in any session record or environment.
   */
  coordinator?: Omit<OpenCode2CoordinatorAuthority, "controlConnection"> & {
    control?: OpenCode2McpConnection;
  };
}

export function openCode2ServerKey(environmentId: string): string {
  return `opencode:${environmentId}`;
}

/** One host start at a time; a start holds the turn until healthy or failed. */
export class OpenCode2StartGate {
  private tail: Promise<void> = Promise.resolve();

  /** Wait for this host's turn. The returned release is safe to call more than once. */
  async acquire(): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => current);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }
}

export class OpenCode2HostServerState {
  /** One OpenCode start at a time on this host. */
  readonly startGate = new OpenCode2StartGate();
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
