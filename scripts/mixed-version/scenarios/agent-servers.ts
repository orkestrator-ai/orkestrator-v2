/**
 * agent-servers across versions (plan item 7009): a current renderer's
 * `agent-servers` client against each node of the pair, without starting a
 * bridge or an agent turn. The host CLI checks answer, a worker's local bridge
 * status is read (a readiness snapshot: it never starts one), the host model
 * catalogue cache and the agent skills scan are read, and the GitHub CLI
 * setup reads answer with no sign-in pending. The backends run as
 * `agent-test`, so every check is "not available" and every list empty; what
 * is qualified is that both adapters reach the commands and that version 1
 * decodes each answer with its schema.
 */
import { agentServersClient } from "@orkestrator/protocol/contract/domains/agent-servers";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "check_claude_cli",
  "check_github_cli",
  "check_any_ai_cli",
  "get_available_ai_cli",
  "get_local_codex_server_status",
  "get_agent_model_catalog_cache",
  "list_agent_skills",
  "get_github_cli_status",
  "get_github_cli_login",
];

export default defineScenario({
  domain: "agent-servers",
  title: "CLI checks, bridge status, catalogue and skills reads, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { client, version, calls } = rendererClient(node, agentServersClient);
      const api = client.api();
      ctx.check(
        `AS-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "agent-servers"),
        `picked ${version}`,
      );

      const claude = await api.check_claude_cli({});
      const github = await api.check_github_cli({});
      const any = await api.check_any_ai_cli({});
      const available = await api.get_available_ai_cli({});
      ctx.check(
        `AS-${tag}2`,
        "the host CLI checks answer",
        typeof claude === "boolean" &&
          typeof github === "boolean" &&
          typeof any === "boolean" &&
          (available === null || typeof available === "string"),
        `any=${String(any)} available=${String(available)}`,
      );

      const status = await api.get_local_codex_server_status({
        environmentId: worker.environmentId,
      });
      ctx.check(
        `AS-${tag}3`,
        "a worker's local bridge status is read without starting the bridge",
        typeof status?.running === "boolean" && status.running === false,
        `running=${String(status?.running)}`,
      );

      const cache = await api.get_agent_model_catalog_cache({});
      const skills = await api.list_agent_skills({ provider: "claude" });
      ctx.check(
        `AS-${tag}4`,
        "the host model catalogue cache and the agent skills scan are read",
        typeof cache === "object" &&
          cache !== null &&
          typeof skills === "object" &&
          skills !== null &&
          Array.isArray(skills.skills),
      );

      const gh = await api.get_github_cli_status({});
      const login = await api.get_github_cli_login({});
      ctx.check(
        `AS-${tag}5`,
        "the GitHub CLI setup reads answer with no sign-in pending",
        typeof gh?.installed === "boolean" && login?.state !== "pending",
        `state=${String(login?.state)}`,
      );
      ctx.note(`agent-servers on ${node.label}`, {
        adapter: version,
        calls: Object.fromEntries(calls),
      });
    }
  },
});
