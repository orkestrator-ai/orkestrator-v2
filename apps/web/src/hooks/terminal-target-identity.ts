/**
 * The fields that identify *which* backend PTY a terminal is asking for.
 *
 * `useTerminal` invalidates an established connection whenever this changes,
 * and `PersistentTerminal` gates its one-shot connection attempt on it. Those
 * two must agree: a field that resets the hook but is absent from the gate
 * would strand a terminal disconnected behind a gate that never reopens, and a
 * field in the gate that the hook ignores would re-probe a live session. One
 * builder is what keeps that from drifting.
 *
 * This lives outside `useTerminal.ts` on purpose. Test files mock the hook
 * module wholesale, and a builder exported from there would be shadowed by
 * every one of those mocks.
 *
 * The requested session id is deliberately not part of this. A session is
 * something the hook resolves for a target, not part of the target itself.
 */
export interface TerminalTargetIdentityInput {
  containerId: string | null;
  environmentId?: string | null;
  isLocal?: boolean;
  terminalKey?: string | null;
  user?: string | null;
  replayOutputBuffer?: boolean;
  attachExistingOnly?: boolean;
  trackEnvironmentActivity?: boolean;
}

export function createTerminalTargetIdentity({
  containerId,
  environmentId,
  isLocal = false,
  terminalKey,
  user,
  replayOutputBuffer = false,
  attachExistingOnly = false,
  trackEnvironmentActivity = false,
}: TerminalTargetIdentityInput): string {
  return JSON.stringify({
    kind: isLocal ? "local" : "container",
    containerId,
    environmentId: environmentId ?? null,
    terminalKey: terminalKey ?? null,
    attachExistingOnly,
    replayOutputBuffer,
    trackEnvironmentActivity,
    user: user ?? null,
  });
}
