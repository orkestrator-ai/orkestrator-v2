/**
 * projects across versions (plan item 7005): a current renderer's `projects`
 * client against each node of the pair. The shared fixture project is listed
 * and read, renamed and renamed back; a scratch project (a remote only, no
 * clone) is added and removed; the host folder picker lists and creates a
 * folder under the scenario's scratch directory; Git remotes are validated;
 * and the default location for a copied project is read. A pre-contract node
 * gets today's calls through version 0. Commands a release predates are
 * skipped, by name.
 *
 * Never started here: a clone, a project from scratch (it runs `git init`
 * and may create a GitHub repository), a project copy, an AGENTS.md pull
 * request.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { projectsClient } from "@orkestrator/protocol/contract/domains/projects";
import type { PeerNode } from "../harness.ts";
import { REPOSITORY_URL } from "../fixtures.ts";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

export default defineScenario({
  domain: "projects",
  title:
    "Project list, rename, add and remove, host folder picker and Git remotes, from a current renderer",
  requires: {
    command: ["get_projects", "get_project", "update_project", "list_host_directory"],
    leaf: ["get_projects", "get_project", "update_project", "list_host_directory"],
  },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const { client, version, calls } = rendererClient(node, projectsClient);
      const projects = client.api();
      const skipped: string[] = [];
      const has = (command: string, of: PeerNode = node) => {
        if (of.has(command)) return true;
        skipped.push(command);
        return false;
      };
      ctx.check(
        `PJ-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "projects"),
        `picked ${version}`,
      );

      const { projectId } = await ctx.fixtures.project(node);
      const listed = await projects.get_projects({});
      const project = await projects.get_project({ projectId });
      ctx.check(
        `PJ-${tag}2`,
        "the fixture project is listed and read with its remote",
        Array.isArray(listed) &&
          listed.some((entry) => entry.id === projectId) &&
          project?.id === projectId &&
          project.gitUrl === REPOSITORY_URL,
      );

      const name = project?.name ?? "";
      const renamed = await projects.update_project({
        projectId,
        updates: { name: `${name} (qualification)` },
      });
      const restored = await projects.update_project({ projectId, updates: { name } });
      ctx.check(
        `PJ-${tag}3`,
        "the project is renamed and renamed back",
        renamed.name === `${name} (qualification)` && restored.name === name,
      );

      if (has("add_project") && has("remove_project")) {
        const gitUrl = `https://github.com/orkestrator-qualification/scratch-${ctx.topology}-${tag}.git`;
        const added = await projects.add_project({ gitUrl });
        const read = await projects.get_project({ projectId: added.id });
        await projects.remove_project({ projectId: added.id });
        const gone = await projects.get_project({ projectId: added.id });
        ctx.check(
          `PJ-${tag}4`,
          "a remote-only project is added, read, and removed",
          added.gitUrl === gitUrl && added.localPath === null && read?.id === added.id && !gone,
        );
      }

      // Both nodes run on this host, so the scenario's own directory is theirs too.
      const root = path.join(ctx.scratch, `picker-${tag}`);
      mkdirSync(root, { recursive: true });
      let created = false;
      if (has("create_host_directory")) {
        const made = await projects.create_host_directory({ parent: root, name: "made" });
        created = made.path === path.join(root, "made");
      }
      const listing = await projects.list_host_directory({ path: root, includeFiles: false });
      ctx.check(
        `PJ-${tag}5`,
        "the host folder picker lists the scratch folder and the folder it created",
        listing.path === root &&
          (!node.has("create_host_directory") ||
            (created &&
              listing.entries.some((entry) => entry.name === "made" && entry.isDirectory))),
      );

      if (has("validate_git_url")) {
        const valid = await projects.validate_git_url({ url: REPOSITORY_URL });
        const invalid = await projects.validate_git_url({ url: "not a remote" });
        ctx.check(`PJ-${tag}6`, "Git remotes are validated", valid === true && invalid === false);
      }

      if (has("get_default_project_location")) {
        const location = await projects.get_default_project_location({ name: "qualification" });
        ctx.check(
          `PJ-${tag}7`,
          "a copied project's default location is under its folder",
          typeof location.location === "string" &&
            location.location.startsWith(location.directory) &&
            ["setting", "projects", "home"].includes(location.source),
          `source ${location.source}`,
        );
      }

      ctx.note(`${node.role} projects`, {
        adapter: version,
        calls: Object.fromEntries(calls),
        skipped,
      });
    }
  },
});
