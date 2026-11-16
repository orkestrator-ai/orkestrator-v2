/**
 * Startup progress lines on the backend's stdout (flake 0080; docs/architecture/backend-runtime.md).
 *
 * Before its `orkestrator-backend-ready` line the backend writes one JSON line
 * per startup phase it reaches:
 *
 *   {"type":"orkestrator-backend-startup","phase":"storage"}
 *
 * A launcher or test can then tell a slow start (phases keep arriving) from a
 * stuck one (no new phase for a while) and name the phase it stopped in,
 * instead of deciding on one deadline for the whole boot. The lines are
 * additive: every launcher already ignores stdout lines whose `type` is not
 * the ready line's (the desktop relays them to its log like any other
 * non-record line). Each names a phase from {@link BACKEND_STARTUP_PHASES} and
 * nothing else: no paths, ports, tokens or other values.
 */

export const BACKEND_STARTUP_LINE_TYPE = "orkestrator-backend-startup";

/** In the order a successful start reaches them. */
export const BACKEND_STARTUP_PHASES = [
  /** Options parsed; the process is running its own code. */
  "process",
  /** Leasing the activated agent toolchains. */
  "toolchains",
  /** Gateway port policy and the SSH agent socket. */
  "host-environment",
  /** `OrkestratorBackend.init()`: opening and upgrading storage. */
  "storage",
  /** Feature stores and services that load from storage. */
  "services",
  /** Taking the registry writer lease and recovering interrupted lifecycle work. */
  "recovery",
  /** Starting the agent-tools server. */
  "agent-tools",
  /** Reaping local servers and tmux runtimes a previous process left behind. */
  "orphan-reaping",
  /** Resuming durable work: reviews, pipelines, graph runs, suborks. */
  "durable-work",
  /** Native agent launches, agent mail and pending setup. */
  "agents",
  /** Starting the gateway and its web-client and Tailscale services. */
  "gateway",
  /** Preview origin publication. */
  "preview-publication",
  /** Publishing the installed-instance descriptor. */
  "instance-descriptor",
] as const;

export type BackendStartupPhase = (typeof BACKEND_STARTUP_PHASES)[number];

export type BackendStartupProgress = (phase: BackendStartupPhase) => void;

/** One startup line, newline-terminated. */
export function backendStartupLine(phase: BackendStartupPhase): string {
  return `${JSON.stringify({ type: BACKEND_STARTUP_LINE_TYPE, phase })}\n`;
}

/**
 * The phase a stdout line reports, or null for any other line (log output, the
 * ready line, an unknown phase from a newer backend).
 */
export function parseBackendStartupLine(line: string): BackendStartupPhase | null {
  if (!line.startsWith("{")) return null;
  try {
    const message = JSON.parse(line) as { type?: unknown; phase?: unknown } | null;
    if (message?.type !== BACKEND_STARTUP_LINE_TYPE) return null;
    return (BACKEND_STARTUP_PHASES as readonly unknown[]).includes(message.phase)
      ? (message.phase as BackendStartupPhase)
      : null;
  } catch {
    return null;
  }
}

/** Reports each phase once, in the order reached; a repeat is dropped. */
export function createBackendStartupProgress(
  write: (text: string) => void,
): BackendStartupProgress {
  const reached = new Set<BackendStartupPhase>();
  return (phase) => {
    if (reached.has(phase)) return;
    reached.add(phase);
    write(backendStartupLine(phase));
  };
}
