/**
 * `nodes` events: the node registry and status, SSH prompts, summaries and
 * outcomes, the portal layout, project copies and relayed leaf events.
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import {
  NODES_CHANGED_EVENT,
  NODE_SSH_PROMPT_EVENT,
  NODE_STATUS_CHANGED_EVENT,
} from "../../../command-nodes.js";
import { RELAYED_NODE_EVENT_PREFIX } from "../../../node-events.js";
import {
  NODE_OUTCOMES_CHANGED_EVENT,
  NODE_SUMMARY_CHANGED_EVENT,
} from "../../../node-summaries.js";
import { PORTAL_LAYOUT_CHANGED_EVENT } from "../../../portal-layout.js";
import { PROJECT_COPY_CHANGED_EVENT } from "../../../project-copy.js";
import { defineEvent, defineEventFamily } from "../../event.js";
import { nodesDomain } from "./domain.js";

/** The node registry changed; clients re-read it. */
export const nodesChangedEvent = defineEvent({
  domain: nodesDomain,
  name: NODES_CHANGED_EVENT,
  payload: Schema.Struct({ revision: Schema.Finite }),
});

/** The whole node status (`get_node_status`'s result). */
export const nodeStatusChangedEvent = defineEvent({
  domain: nodesDomain,
  name: NODE_STATUS_CHANGED_EVENT,
  payload: Schema.ObjectKeyword,
});

/** An SSH askpass prompt opened or closed (`NodeSshPromptView`). */
export const nodeSshPromptEvent = defineEvent({
  domain: nodesDomain,
  name: NODE_SSH_PROMPT_EVENT,
  payload: Schema.Struct({
    promptId: Schema.String,
    nodeId: Schema.String,
    kind: Schema.String,
    message: Schema.String,
    state: Schema.Literals(["open", "closed"]),
  }),
});

/** A node's summary changed; `epoch` orders announcements per node. */
export const nodeSummaryChangedEvent = defineEvent({
  domain: nodesDomain,
  name: NODE_SUMMARY_CHANGED_EVENT,
  payload: Schema.Struct({ nodeId: Schema.String, epoch: Schema.Finite }),
});

/** A node's recorded outcomes changed. */
export const nodeOutcomesChangedEvent = defineEvent({
  domain: nodesDomain,
  name: NODE_OUTCOMES_CHANGED_EVENT,
  payload: Schema.Struct({ nodeId: Schema.String }),
});

/** The portal's machine and project order (`PortalLayout`). */
export const portalLayoutChangedEvent = defineEvent({
  domain: nodesDomain,
  name: PORTAL_LAYOUT_CHANGED_EVENT,
  payload: Schema.Struct({
    revision: Schema.Finite,
    machineOrder: Schema.Array(Schema.String),
    projectOrder: Schema.Array(Schema.String),
  }),
});

/** A cross-node project copy moved to another stage. */
export const projectCopyChangedEvent = defineEvent({
  domain: nodesDomain,
  name: PROJECT_COPY_CHANGED_EVENT,
  payload: Schema.Struct({ copyId: Schema.String, stage: Schema.String }),
});

/**
 * `relayed-node-event:<nodeId>`: a leaf's event relayed by the command node
 * (`RelayedNodeEvent`), or a `resync` frame for that node.
 */
export const relayedNodeEvents = defineEventFamily({
  domain: nodesDomain,
  prefix: RELAYED_NODE_EVENT_PREFIX,
  payload: Schema.Struct({
    nodeId: Schema.String,
    kind: Schema.String,
    event: Schema.optional(Schema.String),
    payload: Schema.optional(Schema.Unknown),
  }),
});

export const NODES_EVENTS = [
  nodesChangedEvent,
  nodeStatusChangedEvent,
  nodeSshPromptEvent,
  nodeSummaryChangedEvent,
  nodeOutcomesChangedEvent,
  portalLayoutChangedEvent,
  projectCopyChangedEvent,
  relayedNodeEvents,
] as const;
