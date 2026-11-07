/**
 * config across versions (plan item 7005): a current renderer's `config`
 * client against each node of the pair. The settings are read (the effective
 * record and the global part alone); a machine setting
 * (`autoMergeRequireChecks`) and a
 * repository setting (`filesToCopy` of the fixture project) are patched and
 * restored, and each node's own copy shows the change; the shared client
 * state is read (its capabilities, notice dismissals, the fixture project's
 * coordinator layout); and the permission rules are listed. A pre-contract
 * node gets today's calls through version 0, including the capability
 * command `config` version 1 folds in. Commands a release predates are
 * skipped, by name.
 *
 * Never written here: a credential, the desktop catalogue, a whole-object
 * save, a permission rule.
 */
import { configClient } from "@orkestrator/protocol/contract/domains/config";
import type { PeerNode } from "../harness.ts";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export default defineScenario({
  domain: "config",
  title:
    "Settings read, global and repository patches, client state and permission rules, from a current renderer",
  requires: {
    command: ["get_config", "get_repository_config", "patch_global_config"],
    leaf: ["get_config", "get_repository_config", "patch_global_config"],
  },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const { client, version, calls } = rendererClient(node, configClient);
      const config = client.api();
      const skipped: string[] = [];
      const has = (command: string, of: PeerNode = node) => {
        if (of.has(command)) return true;
        skipped.push(command);
        return false;
      };
      ctx.check(
        `CF-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "config"),
        `picked ${version}`,
      );

      // Without a known revision the answer is the settings themselves.
      const read: unknown = await config.get_config({});
      const settings = isRecord(read) && isRecord(read.global) ? read : null;
      const global = (settings?.global ?? {}) as Record<string, unknown>;
      ctx.check(
        `CF-${tag}2`,
        "the settings are read with their global part, repositories and no credential",
        settings !== null &&
          typeof settings.version === "string" &&
          isRecord(settings.repositories) &&
          Array.isArray(global.allowedDomains) &&
          !("githubToken" in global) &&
          !("anthropicApiKey" in global),
      );

      // A machine setting (not one a leaf inherits from its command node), which
      // only the PR auto-merge controller reads: flipped and put back.
      const stored = global.autoMergeRequireChecks;
      const waits = stored !== false;
      const flipped = await config.patch_global_config({
        patch: { autoMergeRequireChecks: !waits },
      });
      const own = await node.invoke<{ global?: { autoMergeRequireChecks?: unknown } }>(
        "get_config",
      );
      const back = await config.patch_global_config(
        stored === undefined
          ? { patch: {}, unset: ["autoMergeRequireChecks"] }
          : { patch: { autoMergeRequireChecks: stored } },
      );
      ctx.check(
        `CF-${tag}3`,
        "a machine setting is patched, stored on the node, and restored",
        flipped.global.autoMergeRequireChecks === !waits &&
          own.global?.autoMergeRequireChecks === !waits &&
          back.global.autoMergeRequireChecks === stored,
      );

      const { projectId } = await ctx.fixtures.project(node);
      const repository = await config.get_repository_config({ projectId });
      if (has("patch_repository_settings")) {
        const original = repository.filesToCopy;
        const patched = await config.patch_repository_settings({
          projectId,
          updates: { filesToCopy: ["qualification.txt"] },
        });
        const restored = await config.patch_repository_settings(
          original === undefined
            ? { projectId, unset: ["filesToCopy"] }
            : { projectId, updates: { filesToCopy: original } },
        );
        ctx.check(
          `CF-${tag}4`,
          "a repository setting is patched and restored",
          typeof repository.defaultBranch === "string" &&
            JSON.stringify(patched.repositories[projectId]?.filesToCopy) ===
              JSON.stringify(["qualification.txt"]) &&
            JSON.stringify(restored.repositories[projectId]?.filesToCopy) ===
              JSON.stringify(original),
        );
      }

      const state: Record<string, unknown> = {};
      if (has("get_client_state_capabilities")) {
        const capabilities = await config.clientStateCapabilities();
        state.capabilities = Object.entries(capabilities)
          .filter(([, on]) => on)
          .map(([name]) => name)
          .sort();
        if (capabilities.noticeDismissals && has("list_notice_dismissals")) {
          const dismissals = await config.list_notice_dismissals({});
          state.dismissalRevision = dismissals.revision;
        }
        if (capabilities.coordinatorPaneLayouts && has("get_coordinator_pane_layout")) {
          const layout = await config.get_coordinator_pane_layout({ projectId });
          state.layout = layout === null ? "none" : typeof layout.revision;
        }
      }
      ctx.check(
        `CF-${tag}5`,
        "the shared client state is read",
        !node.has("get_client_state_capabilities") ||
          (Array.isArray(state.capabilities) &&
            (state.dismissalRevision === undefined || typeof state.dismissalRevision === "number")),
        JSON.stringify(state),
      );

      if (has("list_permission_rules")) {
        const rules = await config.list_permission_rules({ projectId });
        ctx.check(
          `CF-${tag}6`,
          "the permission rules are listed",
          Array.isArray(rules.rules) && Array.isArray(rules.applications),
        );
      }

      ctx.note(`${node.role} config`, {
        adapter: version,
        calls: Object.fromEntries(calls),
        skipped,
        state,
      });
    }
  },
});
