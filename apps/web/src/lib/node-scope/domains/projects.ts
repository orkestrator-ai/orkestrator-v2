/**
 * The `projects` domain on a `lib/backend` factory's client (plan item 7005):
 * `projects(client)().get_projects({})`. The adapter is picked per call from
 * the node's negotiated `domains` (`domainApi`,
 * `./domain-api.ts`): version 1 sends the envelope and decodes
 * results, version 0 is today's call (a call without arguments is still sent
 * without them). `lib/backend/projects-environments.ts`, `files-sessions.ts`
 * (the host folder picker and icons), `docker-skills.ts` (Git remotes) and
 * `lib/host-path-picker.ts` call it.
 */
import { projectsClient, type ProjectsApi } from "@orkestrator/protocol/contract/domains/projects";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { ProjectsApi } from "@orkestrator/protocol/contract/domains/projects";

export function projects(client: BackendClient): () => ProjectsApi {
  return () => domainApi(client, projectsClient);
}
