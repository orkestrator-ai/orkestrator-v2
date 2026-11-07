/**
 * Every backend event, by domain (plan item 7011, report §11.1-§11.2).
 *
 * The backend emits only these definitions (`BackendEmit` takes a definition,
 * not a name), the manifest lists them (`scripts/generate-contract-manifest.ts`),
 * and clients subscribe with `listenEvent(client, def, handler)`. A new event
 * is defined in its domain's `events.ts` and added to that domain's list.
 *
 * Browser-safe.
 */
import type { AnyEventDef, AnyEventFamilyDef } from "../event.js";
import { ACCOUNTS_EVENTS } from "./accounts/events.js";
import { AGENT_SERVERS_EVENTS } from "./agent-servers/events.js";
import { CLAUDE_TMUX_EVENTS } from "./claude-tmux/events.js";
import { COORDINATOR_EVENTS } from "./coordinator/events.js";
import { DESIGN_EVENTS } from "./design/events.js";
import { DOCKER_EVENTS } from "./docker/events.js";
import { ENVIRONMENTS_EVENTS } from "./environments/events.js";
import { GIT_EVENTS } from "./git/events.js";
import { MCP_EVENTS } from "./mcp/events.js";
import { NATIVE_SESSIONS_EVENTS } from "./native-sessions/events.js";
import { NODE_MAIL_EVENTS } from "./node-mail/events.js";
import { NODES_EVENTS } from "./nodes/events.js";
import { PREVIEWS_EVENTS } from "./previews/events.js";
import { PULL_REQUESTS_EVENTS } from "./pull-requests/events.js";
import { SYSTEM_EVENTS } from "./system/events.js";
import { TERMINALS_EVENTS } from "./terminals/events.js";
import { TICKET_SYNC_EVENTS } from "./ticket-sync/events.js";
import { WEB_ANNOTATIONS_EVENTS } from "./web-annotations/events.js";

export * from "./accounts/events.js";
export * from "./agent-servers/events.js";
export * from "./claude-tmux/events.js";
export * from "./coordinator/events.js";
export * from "./design/events.js";
export * from "./docker/events.js";
export * from "./environments/events.js";
export * from "./git/events.js";
export * from "./mcp/events.js";
export * from "./native-sessions/events.js";
export * from "./node-mail/events.js";
export * from "./nodes/events.js";
export * from "./previews/events.js";
export * from "./pull-requests/events.js";
export * from "./system/events.js";
export * from "./terminals/events.js";
export * from "./ticket-sync/events.js";
export * from "./web-annotations/events.js";

/** A defined event or event family. */
export type BackendEventDefinition = AnyEventDef | AnyEventFamilyDef;

/** Every event the backend emits: plain definitions and families. */
export const BACKEND_EVENTS: readonly BackendEventDefinition[] = Object.freeze([
  ...ACCOUNTS_EVENTS,
  ...AGENT_SERVERS_EVENTS,
  ...CLAUDE_TMUX_EVENTS,
  ...COORDINATOR_EVENTS,
  ...DESIGN_EVENTS,
  ...DOCKER_EVENTS,
  ...ENVIRONMENTS_EVENTS,
  ...GIT_EVENTS,
  ...MCP_EVENTS,
  ...NATIVE_SESSIONS_EVENTS,
  ...NODE_MAIL_EVENTS,
  ...NODES_EVENTS,
  ...PREVIEWS_EVENTS,
  ...PULL_REQUESTS_EVENTS,
  ...SYSTEM_EVENTS,
  ...TERMINALS_EVENTS,
  ...TICKET_SYNC_EVENTS,
  ...WEB_ANNOTATIONS_EVENTS,
]);

/**
 * The definition behind an event name: an exact event, or the family whose
 * prefix it starts with. `null` for a name no definition covers.
 */
export function backendEventFor(name: string): BackendEventDefinition | null {
  for (const def of BACKEND_EVENTS) {
    if (def.kind === "event" ? def.name === name : def.keyOf(name) !== null) return def;
  }
  return null;
}
