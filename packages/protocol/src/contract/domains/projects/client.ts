/**
 * The `projects` domain client (plan item 7005; §11.2 "Client adapters"):
 * one function per command, keyed by the command's name
 * (`api.get_projects(args)`). The web binds it per `lib/backend` client
 * (`apps/web/src/lib/node-scope/domains/projects.ts`).
 *
 * No `projects` command was capability-gated and the domain has no
 * capability command, so both adapters call the same commands:
 *
 * - **Version 1** (a node whose hello advertises `projects`): calls carry the
 *   envelope (the domain version and the critical keys the arguments hold)
 *   and results are decoded with the command's schema.
 * - **Version 0** (a pre-contract node): today's untyped call by name,
 *   without an envelope, answered as the node sent it. An older node's
 *   results are the shapes its callers already read; a command such a node
 *   lacks (`arrange_projects_by_intent` before it existed) answers
 *   `unknown-command`, which the caller reads with `incompatibility()` as
 *   before.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `projects` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
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

const legacyApi = (_call: CommandCall, context: DomainAdapterContext): ProjectsApi =>
  projectsApi((command, args) =>
    context.invoke(command.name, args as Readonly<Record<string, unknown>> | undefined),
  );

export const projectsClient = domainClient(projectsDomain, {
  2: currentApi,
  // Version 2 only removed commands nothing called (2026-11-10), so version 1
  // peers take the same API. Adapter 1 goes when the support floor passes the
  // first Stable release with version 2.
  1: currentApi,
  0: legacyApi,
});
