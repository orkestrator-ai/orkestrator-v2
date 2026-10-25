/** In-process identity of an authenticated node-link request; JSON cannot set it. */
const CONTROLLER = Symbol("public-action-controller");

export function withRelayController(args: Record<string, unknown>, controllerId: string) {
  return Object.assign({ ...args }, { [CONTROLLER]: controllerId });
}

export function relayController(args: Record<string, unknown>): unknown {
  return (args as { [CONTROLLER]?: unknown })[CONTROLLER];
}
