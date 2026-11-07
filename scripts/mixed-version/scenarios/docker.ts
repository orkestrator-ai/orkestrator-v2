/**
 * docker across versions (plan item 7003): a current renderer's `docker`
 * client against each node of the pair, reads only. Docker availability and
 * the host-reachability snapshot read back whether or not the node's host
 * runs Docker; the Orkestrator container list reads back when Docker is
 * available and is refused (an error, not a crash) when the node cannot run
 * the `docker` CLI, as on a host whose Docker is outside the run's
 * constructed `PATH` (2026-11-07: the first live run). Version 1 decodes every
 * answer with the protocol schema; version 0 is today's call, answered as
 * sent. Nothing here creates, starts, stops or removes a container.
 */
import { dockerClient } from "@orkestrator/protocol/contract/domains/docker";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = ["check_docker", "get_container_host_reachability", "get_orkestrator_containers"];

export default defineScenario({
  domain: "docker",
  title: "Docker availability and container reads, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const { client, version, calls } = rendererClient(node, dockerClient);
      const docker = client.api();
      ctx.check(
        `DK-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "docker"),
        `picked ${version}`,
      );
      const availability = await docker.checkDocker();
      ctx.check(
        `DK-${tag}2`,
        "Docker availability answers a boolean, with a reason when unavailable",
        typeof availability.available === "boolean",
      );
      const reachability = await docker.hostReachability();
      const containers = await docker.orkestratorContainers().then(
        (list) => ({ list }),
        (error: unknown) => ({ refusal: String(error).slice(0, 200) }),
      );
      ctx.check(
        `DK-${tag}3`,
        "the reachability snapshot reads back, and the container list reads back (refused only without Docker)",
        typeof reachability === "object" &&
          reachability !== null &&
          ("list" in containers ? Array.isArray(containers.list) : !availability.available),
        "refusal" in containers ? containers.refusal : undefined,
      );
      ctx.note(`${node.role} docker`, {
        adapter: version,
        available: availability.available,
        containers: "list" in containers ? containers.list.length : "refused",
        calls: Object.fromEntries(calls),
      });
    }
  },
});
