import { defineLogAreas } from "./define.js";

export const DOCKER_LOG_AREAS = defineLogAreas({
  docker: {
    description:
      "Docker containers: lifecycle, starts, staged inputs and the login files they hold.",
    events: {
      "portable-inputs.relay-missing":
        "Docker is rootless and the image predates the staged-input relay, so the container cannot read them until rebuilt.",
      "opencode.warm-incomplete": "OpenCode did not finish loading /workspace in a container.",
      "login-keeper.pass-failed": "A Claude login keeper pass failed; the next interval retries.",
      "login-keeper.refresh-failed":
        "Refreshing the host Claude login failed. Fixed text: CLI output can hold credentials.",
      "login-keeper.refresh-not-extended":
        "Refreshing the host Claude login did not extend its expiry.",
      "login-keeper.refresh-check-failed": "Checking the host Claude login after a refresh failed.",
      "login-watcher.pass-failed":
        "A container login file watcher pass failed; the next one retries.",
      "lifecycle.record-failure-failed": "A failed container operation could not be recorded.",
      "lifecycle.reconcile-failed":
        "Reconciling one environment's container operation failed; the next pass retries.",
      "replacement.clear-terminals-failed":
        "Terminal sessions could not be cleared after a container replacement.",
      "recovery.clear-terminals-failed":
        "Terminal sessions could not be cleared after a recovery restore.",
      "github-ranges.seed-not-copied":
        "The GitHub ranges seed could not be copied into a container, so its firewall fetches them.",
      "availability.probe-failed":
        "Docker is not available; written when the diagnostic changes. Fixed-shape metadata only: messages can hold daemon endpoints.",
      "start.port-collision-retrying":
        "An automatic host port collided on start, so it is retried once with fresh ports.",
    },
  },
  "docker.reachability": {
    description: "Whether agents in containers can reach the backend's agent tools server.",
    events: {
      "check.crashed": "A reachability check crashed.",
      "check.started": "A reachability check started.",
      "check.finished": "A reachability check finished.",
      "check.probe": "One probe of a finished check.",
      "check.summary":
        "Content-free status and reason for a check that did not find the host reachable.",
      "check.remediation": "One command the user can run to unblock containers.",
      "shutdown.awaiting-network": "Shutdown is waiting for probe network preparation.",
      "shutdown.cleanup-deferred": "Probe network cleanup waits until its preparation settles.",
      "shutdown.removing-resources": "Shutdown is removing probe resources.",
      "shutdown.container-remove-failed": "A probe container could not be removed at shutdown.",
      "shutdown.network-remove-failed": "The probe network could not be removed at shutdown.",
      "probe.skipped":
        "A container probe was skipped because the agent tools server is not listening.",
      "preflight.refused": "A stage was refused because its container cannot reach the host.",
      "probe.prepare-failed": "A container could not be prepared for a probe.",
      "probe.result": "The outcome of probing one container.",
      "probe.contradicts-host":
        "A container probe disagrees with the host status, so the host is rechecked.",
      "topology.detected": "The Docker topology was read.",
      "firewall.detected": "The host firewall was read.",
      "probe-network.remove-failed": "The probe network could not be removed.",
      "probe-network.create-failed":
        "The probe network could not be created, so only the default bridge is checked.",
      "event.emit-failed": "A reachability event could not be emitted.",
      "host-addresses.list-failed": "Host addresses could not be listed.",
      "probe-image.present": "The probe image is already present.",
      "probe-image.pulling": "The probe image is being pulled.",
      "probe-image.pulled": "The probe image was pulled.",
      "probe-image.pull-failed": "The probe image could not be pulled.",
      "probe-image.fallback": "The environment image is used as the probe image.",
      "probe-image.missing": "No probe image is available.",
      "network.list-failed": "Docker networks could not be listed.",
      "network.inspect-failed": "A Docker network could not be inspected.",
      "stale-containers.removing": "Stale probe containers are being removed.",
      "stale-networks.removing": "Stale probe networks are being removed.",
    },
  },
});
