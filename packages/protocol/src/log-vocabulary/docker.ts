import { defineLogAreas } from "./define.js";

export const DOCKER_LOG_AREAS = defineLogAreas({
  docker: {
    description:
      "Docker containers: lifecycle, starts, staged inputs and the login files they hold.",
    events: {
      "portable-inputs.relay-missing":
        "Docker is rootless and the image predates the staged-input relay, so the container cannot read them until rebuilt.",
      "git-mirror.mount-unavailable":
        "A new container gets no project Git mirror, so its clone goes to the remote.",
      "git-mirror.mount-withheld":
        "A new restricted container gets no project Git mirror because its firewall would not let it reach the project's remote, so it cannot read what the remote serves through the mirror either.",
      "git-mirror.refreshed": "A project's Git mirror was built or updated.",
      "git-mirror.seeded":
        "A project's Git mirror was built from its host checkout and only what the remote added to it.",
      "git-mirror.seed-skipped":
        "A project's host checkout could not seed its Git mirror, so the build downloads everything.",
      "git-mirror.refresh-failed":
        "A project's Git mirror could not be updated. New clones still work, from the mirror as it was or from the remote.",
      "git-mirror.low-disk": "A project's Git mirror was not updated: the disk is nearly full.",
      "git-mirror.oversized":
        "A project's repository is too large for a Git mirror, so its environments keep the blobless clone.",
      "git-mirror.compact-failed": "A project's Git mirror could not be compacted.",
      "git-mirror.state-write-failed": "A project's Git mirror could not be marked for checking.",
      "git-mirror.remove-failed": "A project's Git mirror could not be removed; a sweep retries.",
      "git-mirror.orphans-removed": "Git mirrors of removed projects were removed.",
      "git-mirror.clone-used": "A new environment cloned from its project's Git mirror.",
      "git-mirror.clone-fallback":
        "A new environment could not clone from its project's Git mirror and cloned from the remote.",
      "project-seed.refused":
        "A project .env, .env.local or opencode.json was not copied into a new container: a link, not a regular file, outside the project, too large or unreadable.",
      "opencode.warm-incomplete": "OpenCode did not finish loading /workspace in a container.",
      "log-driver.unbounded":
        "The Docker daemon offers neither the local nor the json-file log driver, so new containers keep its default driver, whose log may be uncapped. Written once per backend.",
      "lifecycle-event.reconcile-failed":
        "Reconciling an environment after a container start or stop event failed; the next status read retries.",
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
      "writer-lease.lost": {
        description:
          "This backend lost the registry writer lease, for the fixed `reason` given. Schedules stop and container changes are refused until it restarts.",
        essential: true,
        fields: { reason: "label" },
      },
      "writer-lease.regained": {
        description:
          "This backend took the registry writer lease over from a holder that stopped refreshing it (it crashed, was killed or stalled), `staleForMs` after its last refresh. The counterpart of that holder's `writer-lease.lost` with reason `reclaimed`; a lease left by a clean shutdown is acquired silently.",
        essential: true,
        fields: { staleForMs: "number" },
      },
      "writer-lease.listener-failed":
        "The callback told about a lost registry writer lease threw, so the schedules settings learn of the loss only at their next read.",
      "writer-lease.not-acquired": {
        description:
          "This backend started without the registry writer lease, for the fixed `reason` given. A second backend on one data directory is normal: it serves reads, runs no schedules and refuses container changes.",
        essential: true,
        fields: { reason: "label" },
      },
      "bridge.launched": {
        description:
          "A bridge process was launched in a container, for the first time there or as a relaunch; `provider` names it. A relaunch keeps the run before it in the previous log.",
        essential: true,
        fields: { provider: "label", containerPort: "number" },
      },
      "bridge.listener-refused": {
        description:
          "The socket listening on a container bridge's port is not the one the bridge the backend started opened (to-do 7250), so its token is not handed out and the next start replaces it. `reason` is a fixed label: `different-socket`, `several-sockets`, `pending` (a start has not recorded its bridge yet, or failed before it did) or `scan-incomplete`.",
        essential: true,
        fields: { provider: "label", reason: "label" },
      },
      "bridge.listener-adopted":
        "A running container bridge had no listener record, because a backend from before the record started it, so the socket on its port was recorded as the bridge's; `provider` names it.",
      "bridge.listener-unrecorded": {
        description:
          "A bridge the backend just launched could not be recorded as its port's listener, for the fixed `reason` given (`no-listener`, `several-sockets`, `launch-exited` or `scan-incomplete`); what listens on the port is stopped and the start fails.",
        essential: true,
        fields: { provider: "label", reason: "label" },
      },
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
      "peers.refused":
        "The agent tools server closed connections from addresses outside loopback and this backend's Docker networks (at most one entry a minute, with a count).",
      "peers.subnets-loaded": "The Docker subnets the agent tools server admits were reloaded.",
      "port.loopback-taken":
        "The agent tools server gave up a port because another process holds it on 127.0.0.1, where host agents call; it moves to a free port.",
      "peers.subnets-load-failed":
        "The Docker subnets the agent tools server admits could not be read; cached permissions are cleared and only loopback is admitted until a successful retry.",
    },
  },
});
