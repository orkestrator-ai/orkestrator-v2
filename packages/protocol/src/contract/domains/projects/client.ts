/**
 * The `projects` domain client (plan item 7005; §11.2 "Client adapters"):
 * one function per command, keyed by the command's name
 * (`api.get_projects(args)`). The web binds it per `lib/backend` client
 * (`apps/web/src/lib/node-scope/domains/projects.ts`).
 *
 * The domain has no capability command. **Version 2** (a node whose hello
 * advertises `projects`): calls carry the envelope (the domain version and
 * the critical keys the arguments hold) and results are decoded with the
 * command's schema.
 *
 * Only the current version has an adapter: the older ones went with the
 * one-time support floor v2.39.1-beta (to-do 8304 (retired), 2026-11-26). A domains map
 * that omits this domain yields `unsupported-version`. Without a domains
 * map, calls use the lowest adapter unnegotiated. Later bumps keep an
 * adapter for every version a release in the 60-day window speaks.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall } from "../../client.js";
import type { ArgsOf, ResultOf } from "../../command.js";
import { PROJECTS_COMMANDS } from "./commands.js";
import { projectsDomain } from "./domain.js";

/** Every `projects` command definition. */
export type ProjectsCommand = (typeof PROJECTS_COMMANDS)[number];

/** One function per command, keyed by the command's name. */
export type ProjectsApi = {
  readonly [C in ProjectsCommand as C["name"]]: (args: ArgsOf<C>) => Promise<ResultOf<C>>;
};

function projectsApi(
  run: (command: ProjectsCommand, args: unknown) => Promise<unknown>,
): ProjectsApi {
  const api: Record<string, (args: unknown) => Promise<unknown>> = {};
  for (const command of PROJECTS_COMMANDS) api[command.name] = (args) => run(command, args);
  return Object.freeze(api) as ProjectsApi;
}

const currentApi = (call: CommandCall): ProjectsApi =>
  projectsApi((command, args) => call(command, args as ArgsOf<typeof command>));

export const projectsClient = domainClient(projectsDomain, {
  2: currentApi,
});
