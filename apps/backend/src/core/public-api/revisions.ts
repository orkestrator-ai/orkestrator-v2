/**
 * Content revisions for the resources public callers edit.
 *
 * A revision is a hash of exactly the fields a public edit can change, so
 * every writer — the desktop UI's legacy commands included — advances it
 * without being modified, and an unrelated field (sidebar order, activity
 * timestamps, remembered launch choices) never causes a spurious conflict.
 * The check and the write happen under the same storage lock.
 *
 * A-B-A sequences compare equal; that is harmless for lost-update protection
 * because the patch then applies to exactly the values its author read.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@orkestrator/protocol/public-api";
import type { Environment, Project, RepositoryConfig } from "../models.js";

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 20);
}

export function projectRevision(project: Project): string {
  return digest({
    id: project.id,
    name: project.name,
    gitUrl: project.gitUrl,
    localPath: project.localPath ?? null,
    folder: project.folder ?? null,
  });
}

export function repositorySettingsRevision(config: RepositoryConfig | undefined): string {
  if (!config) return digest({ absent: true });
  const {
    lastEnvironmentType: _lastEnvironmentType,
    lastEnvironmentAgentSelection: _lastEnvironmentAgentSelection,
    ...editable
  } = config;
  return digest(editable);
}

export function environmentSettingsRevision(environment: Environment): string {
  return digest({
    portMappings: environment.portMappings ?? null,
    allowedDomains: environment.allowedDomains ?? null,
    agentSettings: environment.agentSettings ?? null,
  });
}
