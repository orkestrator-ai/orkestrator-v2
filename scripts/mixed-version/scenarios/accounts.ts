/**
 * accounts across versions (plan item 7008): a current renderer's `accounts`
 * client against each node of the pair, without any login, credential or
 * provider call. Accounts are listed and the login is idle; the coordinator
 * account-switch grant is set and restored; the main automatic-switching tick
 * is written off from off (never on: switching on can read plan usage);
 * the preferred login is set, read back through the machines overview and
 * cleared; the host sign-ins, a platform's sign-in state, a project's usage
 * limits and the usage history are read. A pre-contract node gets today's
 * calls through version 0. Commands a release predates are skipped, by name.
 *
 * Never started here: an account or OpenCode login, a sign-in terminal, an
 * API key, a plan-usage read, the Cursor SDK login.
 */
import { accountsClient } from "@orkestrator/protocol/contract/domains/accounts";
import type { PeerNode } from "../harness.ts";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const PREFERRED = "qualification@example.com";

export default defineScenario({
  domain: "accounts",
  title:
    "Accounts, switch grant, auto-switch tick, preferred login and usage reads, from a current renderer",
  requires: {
    command: ["list_agent_accounts", "get_agent_account_login"],
    leaf: ["list_agent_accounts", "get_agent_account_login"],
  },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const { client, version, calls } = rendererClient(node, accountsClient);
      const accounts = client.api();
      const skipped: string[] = [];
      const has = (command: string, of: PeerNode = node) => {
        if (of.has(command)) return true;
        skipped.push(command);
        return false;
      };
      ctx.check(
        `AC-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "accounts"),
        `picked ${version}`,
      );

      const snapshot = await accounts.list_agent_accounts({});
      const login = await accounts.get_agent_account_login({});
      ctx.check(
        `AC-${tag}2`,
        "accounts are listed with the active account per platform, and no login is running",
        Array.isArray(snapshot.accounts) &&
          typeof snapshot.active === "object" &&
          login.state !== "pending",
        `login ${login.state}`,
      );

      if (
        has("get_coordinator_account_switch_grant") &&
        has("set_coordinator_account_switch_grant")
      ) {
        const before = await accounts.get_coordinator_account_switch_grant({ platform: "claude" });
        const original = before.grants.claude === true;
        const flipped = await accounts.set_coordinator_account_switch_grant({
          platform: "claude",
          enabled: !original,
        });
        const restored = await accounts.set_coordinator_account_switch_grant({
          platform: "claude",
          enabled: original,
        });
        ctx.check(
          `AC-${tag}3`,
          "the coordinator switch grant is set and restored, with its limit",
          flipped.grants.claude === !original &&
            restored.grants.claude === original &&
            typeof restored.limit.switches === "number",
        );
      }

      // Only from off: turning it on can read plan usage, and a pin would end.
      const mode = autoSwitchMode(snapshot.autoSwitch, "claude");
      if (has("set_agent_account_auto_switch") && (mode === undefined || mode === "off")) {
        const off = await accounts
          .set_agent_account_auto_switch({ platform: "claude", enabled: false })
          .then(
            (answer) => ({ answer }),
            (error: unknown) => ({ refusal: String(error) }),
          );
        // An attached leaf takes these ticks from its command node and refuses
        // the write, naming it (`updateAgentAccountAutoSwitchSettings`); an
        // older leaf may still take it. 2026-11-07: the first live run.
        if ("refusal" in off) {
          ctx.check(
            `AC-${tag}4`,
            "an attached leaf refuses the automatic-switching tick, naming its command node",
            node.role === "leaf" && /command node/iu.test(off.refusal),
            off.refusal.slice(0, 200),
          );
        } else {
          ctx.check(
            `AC-${tag}4`,
            "the automatic-switching tick is written (off, as it was) without switching",
            off.answer.active.claude === snapshot.active.claude &&
              (autoSwitchMode(off.answer.autoSwitch, "claude") ?? "off") === "off",
          );
        }
      }

      if (has("set_preferred_agent_identity") && has("list_machine_agent_accounts")) {
        const before = await accounts.list_machine_agent_accounts({});
        const original = before.preferred?.claude ?? null;
        await accounts.set_preferred_agent_identity({ platform: "claude", email: PREFERRED });
        const overview = await accounts.list_machine_agent_accounts({});
        const cleared = await accounts.set_preferred_agent_identity({
          platform: "claude",
          email: original,
        });
        ctx.check(
          `AC-${tag}5`,
          "the preferred login is kept, shown by the overview with this machine, and restored",
          overview.preferred?.claude === PREFERRED &&
            overview.machines.some((machine) => machine.self) &&
            (cleared.claude ?? null) === original,
        );
      }

      const reads: Record<string, unknown> = {};
      if (has("read_host_agent_sign_ins")) {
        const signIns = await accounts.read_host_agent_sign_ins({});
        reads.hostSignIns = Object.keys(signIns).sort();
      }
      if (has("get_agent_sign_in_status")) {
        reads.claudeSignIn = (
          await accounts.get_agent_sign_in_status({ platform: "claude" })
        ).state;
      }
      if (has("get_project_usage_limits")) {
        const { projectId } = await ctx.fixtures.project(node);
        const limits = await accounts.get_project_usage_limits({ projectId });
        reads.limitedTabs = limits.limitedTabs.length;
      }
      if (has("get_usage_history")) {
        const history = await accounts.get_usage_history({ days: 7 });
        reads.usageDays = history.days.length;
      }
      ctx.check(
        `AC-${tag}6`,
        "the sign-in, usage-limit and usage-history reads answer without a provider call",
        (reads.usageDays === undefined || reads.usageDays === 7) &&
          (reads.limitedTabs === undefined || typeof reads.limitedTabs === "number"),
        JSON.stringify(reads),
      );
      ctx.note(`${node.role} accounts`, {
        adapter: version,
        calls: Object.fromEntries(calls),
        skipped,
        reads,
      });
    }
  },
});

/** `platform`'s automatic-switching mode (`off`, `automatic`, `pinned`) from a snapshot's `autoSwitch`. */
function autoSwitchMode(autoSwitch: unknown, platform: string): string | undefined {
  if (!autoSwitch || typeof autoSwitch !== "object") return undefined;
  const state = (autoSwitch as Record<string, unknown>)[platform];
  if (!state || typeof state !== "object") return undefined;
  const mode = (state as { mode?: unknown }).mode;
  return typeof mode === "string" ? mode : undefined;
}
