/** A host bridge reports a successful bind over its own child's stdout pipe. */
export const LOCAL_BRIDGE_READY_PREFIX = "Orkestrator bridge listening on port ";

export function announceLocalBridgeReady(port: number): void {
  process.stdout.write(`${LOCAL_BRIDGE_READY_PREFIX}${port}\n`);
}
