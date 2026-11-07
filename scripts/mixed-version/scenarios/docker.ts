/**
 * docker across versions (plan item 7003): a current renderer's `docker`
 * client against each node of the pair, reads only. Docker availability,
 * the host-reachability snapshot and the Orkestrator container list read
 * back whether or not the node's host runs Docker. Version 1 decodes every
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
      const containers = await docker.orkestratorContainers();
      ctx.check(
        `DK-${tag}3`,
        "the reachability snapshot and the container list read back",
        typeof reachability === "object" && reachability !== null && Array.isArray(containers),
      );
      ctx.note(`${node.role} docker`, {
        adapter: version,
        available: availability.available,
        calls: Object.fromEntries(calls),
      });
    }
  },
});
