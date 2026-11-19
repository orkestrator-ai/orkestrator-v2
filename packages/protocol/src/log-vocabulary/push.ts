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
      "native-session.listener-failed":
        "An in-process holder of an observed session (the tool-output topic) threw on a change.",
      "tool-output.hold-failed":
        "The tool-output topic could not hold a call's session; the row's subscription stays without announcements and it keeps its fallback poll.",
      "tool-output.source-failed":
        "Looking a tool call up in its session's cached live view threw; nothing is announced for that change.",
      "node-subscriptions.apply-failed":
        "The node subscription controller threw while registering a relayed node's set; the set is answered unavailable and its views poll.",
      "node-subscriptions.close-failed":
        "The node subscription controller threw while dropping a closed connection's relayed sets.",
      "node-subscriptions.leaf-set-failed":
        "Sending a relayed node the union of its subscriptions failed; the windows viewing it keep polling until it is sent again.",
      "workflow.read-failed":
        "A workflow run's summary read failed; it retries after a pause and the views keep their recovery poll.",
      "workflow.publish-failed": "Announcing a workflow run's change to its subscribers threw.",
      "review-transcript.read-failed":
        "A Multi Review reviewer or step record read failed; it retries after a pause and the views keep their recovery poll.",
      "review-transcript.probe-failed":
        "The fallback transcript read of a reviewer whose bridge announces no revisions failed; the next probe tries again.",
      "review-transcript.publish-failed":
        "Announcing a reviewer transcript's change to its subscribers threw.",
      "environment.read-failed":
        "An environment observer's record or registry read failed; it retries after a pause and the views keep their recovery poll.",
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
