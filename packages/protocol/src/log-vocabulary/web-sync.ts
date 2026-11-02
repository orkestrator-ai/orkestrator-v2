import { defineLogAreas } from "./define.js";

export const WEB_SYNC_LOG_AREAS = defineLogAreas({
  "web.resource-sync": {
    description: "Keeping renderer stores current with backend resources.",
    events: {
      "handler.threw": "A resource change handler threw; other handlers still ran.",
      "resync-handler.threw": "A resync handler threw; the resync counts as failed.",
      "view-safety-check.threw": "A view safety check handler threw; the others still ran.",
      "snapshots.batch-failed": "A scoped snapshot batch failed; individual reads take over.",
      "manifest.scoped-check-failed": "The scoped manifest read failed; a full resync runs.",
      "manifest.check-failed": "The manifest read failed; a full resync runs.",
      "subscribe.failed": "Subscribing to a resource transport event failed.",
      "change.malformed": "A resource-changed payload had the wrong shape and was dropped.",
      "config.refresh-failed": "Refreshing the config store after a change failed.",
      "pane-layout.refresh-failed": "Refreshing an environment's pane layout failed.",
      "setup-completion.observe-failed": "Subscribing to setup completion events failed.",
      "resync.project-failed": "The authoritative project read failed during a store resync.",
      "resync.environment-failed": "The authoritative environment read failed during a resync.",
      "resync.read-failed": "One of a store resync's per-environment reads failed.",
      "resync.pane-failed": "A pane layout read failed during a store resync.",
      "agent-mail.summary-refresh-failed": "Refreshing the agent mail summary failed.",
      "agent-mail.mailbox-refresh-failed": "Refreshing one agent mailbox failed.",
      "prompt-queues.refresh-failed": "Refreshing an environment's prompt queues failed.",
      "build-pipeline.refresh-failed": "Refreshing one build pipeline failed.",
      "multi-review.refresh-failed": "Refreshing one multi review workflow failed.",
      "authoritative.resync-failed": "Re-reading a snapshot after a stream reconnect failed.",
      "observation.listener-threw": "A native observation invalidation listener threw.",
      "observation.subscribe-failed": "Subscribing to native observation events failed.",
      "hydration.status-listener-failed": "A bounded hydration status listener threw.",
      "hydration.notification-failed": "A bounded hydration change notification threw.",
    },
  },
  "web.read-coordinator": {
    description: "The renderer's coalesced, bounded backend reads.",
    events: {
      "listener.threw": "A read state listener threw.",
      "read.settle-failed": "Applying a finished read's result threw.",
    },
  },
  "web.gateway": {
    description: "The renderer's connection to the gateway: requests and event streams.",
    events: {
      "events.disconnected": "The main event stream dropped; it reconnects and replays.",
      "terminal-stream.disconnected": "A terminal event stream dropped; it reconnects.",
      "connection-listener.failed": "A main stream connection state listener threw.",
      "event-listener.failed": "A listener for a gateway event threw.",
      "stream-listener.failed": "A listener for the stream-connected notice threw.",
    },
  },
  "web.federation": {
    description: "Events from federated nodes as the renderer receives them.",
    events: {
      "resync-handler.failed": "A node resync handler failed.",
      "event-handler.failed": "A handler for an event relayed from a node failed.",
      "environment.start-failed": "Starting an environment opened in a workspace window failed.",
    },
  },
});
