import { defineLogAreas } from "./define.js";

/** The push event layer (docs/architecture/push-events.md). Content-free: no keys, ids or revisions. */
export const PUSH_LOG_AREAS = defineLogAreas({
  push: {
    description:
      "The push event layer: per-stream subscriptions, change frames and the topic observers behind them.",
    events: {
      "subscription.resolve-failed":
        "A topic could not read a subscription's stamp; the key is answered missing and its view polls.",
      "topic.retain-failed":
        "A topic failed to start observing a key; the key keeps its subscription.",
      "topic.release-failed": "A topic failed to stop observing a key.",
      "frame.write-failed":
        "Writing a push frame threw; the connection is closed and its client re-subscribes.",
      "native-session.read-failed":
        "A session observer's read failed; it retries after a pause and the views keep their recovery poll.",
      "native-session.wake-hook-failed": "Dropping a woken session's shared reads threw.",
      "native-session.observe-hook-failed": "Registering an observed session's shared reads threw.",
    },
  },
  "web.push": {
    description: "The renderer's push subscriptions over its gateway event stream.",
    events: {
      "listener.failed": "A view's push change listener threw.",
      "subscribe.failed":
        "The renderer could not attach to its node's push frames; views keep polling.",
    },
  },
});
