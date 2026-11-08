import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const BACKEND_LOG_AREAS = defineLogAreas({
  "build.pipeline": {
    description: "Build delivery, ticket reconciliation and persisted pipeline recovery.",
    events: {
      "delivery-policy.failed":
        "A ticket delivery edit could not be reconciled with the running build.",
      "criteria.failed": "Verify could not record criterion results on the ticket.",
      "transcript-maintenance.failed": "Pipeline transcript maintenance failed.",
      "hydrate.failed": "The renderer could not load the authoritative pipeline snapshot.",
    },
  },
  "backend.activity": {
    description: "The backend's recurring activity and maintenance jobs.",
    events: {
      "job.failed": "One pass of the job named in `scope` failed; its next pass retries.",

      ...THROTTLE_LOG_EVENTS,
    },
  },
  backend: {
    description: "The backend process: startup, background notices and shutdown.",
    events: {
      starting: {
        description: "The backend process is starting.",
        essential: true,
        fields: { version: "label" },
      },
      "ssh-socket.resolved": "An SSH agent socket was found.",
      "ssh-socket.missing": "No usable SSH agent socket was found.",
      "standalone-updater.mismatch":
        "--standalone-updater does not match --data-dir, so self-update is off.",
      "instance.publish-failed": "The instance descriptor could not be published.",
      "instance.republish-failed":
        "The instance descriptor could not be republished; a later pass retries.",
      "parent.exited": "The parent process exited, so local servers are shutting down.",
      "startup.step-failed":
        "One part of startup failed and the backend carried on; `step` says which.",
      "startup.failed":
        "Startup failed; the backend released what it had started and exits with code 1.",
      "startup.setup-fence-failed": "An environment's interrupted setup could not be fenced.",
      "startup.setup-adopt-failed": "An environment's pending setup could not be adopted.",
      "startup.deletion-pending":
        "An interrupted environment deletion stays pending. Its owning step logged the detail.",
      "startup.looped-review-pending": "Cleanup of the retired Looped Review stays pending.",
      "notice.failed": "A background notice after a turn or prompt failed; `step` says which.",
      "command.slow":
        "A registered command took at least 2 s to settle, or its synchronous part held the event loop for at least 250 ms (then at warn): `command`, `durationMs`, `syncMs` and `outcome`. Repeats of one command within a minute are folded into the next line.",
      "artifacts.live-unavailable": "Live interactive artifacts are unavailable.",
      "previous-run": {
        description:
          "This start read how the previous run ended: `outcome` is `clean` when it reached the end of shutdown and `crashed` when it did not, `ranForMs` its length and `lastSeenAgoMs` the time since its last health row.",
        essential: true,
        fields: { outcome: "label", ranForMs: "number", lastSeenAgoMs: "number" },
      },
      "health.write-failed":
        "A health summary row could not be written or read; the next sample retries.",
      "shutdown.step-failed":
        "One part of shutdown failed and the rest went on; `step` says which.",
      "shutdown.signal-received": {
        description:
          "A signal started shutdown, which tells a clean quit from the backend being killed.",
        essential: true,
        fields: { signal: "label" },
      },
      "shutdown.finished": {
        description: "Shutdown finished, and the process exits with `code`.",
        essential: true,
        fields: { code: "number" },
      },
      "port-policy.second-backend":
        "Another backend serves the default data directory, so this one avoids its ports.",
      "port-policy.serve-on-free-port":
        "--tailscale-serve is on a free gateway port; pass --port with --strict-gateway-port to keep one.",
    },
  },
});
