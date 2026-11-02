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
      starting: "The backend process is starting.",
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
      "startup.setup-fence-failed": "An environment's interrupted setup could not be fenced.",
      "startup.setup-adopt-failed": "An environment's pending setup could not be adopted.",
      "startup.deletion-pending":
        "An interrupted environment deletion stays pending. Its owning step logged the detail.",
      "startup.looped-review-pending": "Cleanup of the retired Looped Review stays pending.",
      "notice.failed": "A background notice after a turn or prompt failed; `step` says which.",
      "artifacts.live-unavailable": "Live interactive artifacts are unavailable.",
      "shutdown.step-failed":
        "One part of shutdown failed and the rest went on; `step` says which.",
      "shutdown.signal-received":
        "A signal started shutdown, which tells a clean quit from the backend being killed.",
      "shutdown.finished": "Shutdown finished, and the process exits with `code`.",
      "port-policy.second-backend":
        "Another backend serves the default data directory, so this one avoids its ports.",
      "port-policy.serve-on-free-port":
        "--tailscale-serve is on a free gateway port; pass --port with --strict-gateway-port to keep one.",
    },
  },
});
