import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RuntimeProfile } from "../../electron/runtime-profile.js";

type Project = { id: string; localPath?: string };
type Environment = {
  id: string;
  name?: string;
  environmentType?: string;
  status?: string;
  networkAccessMode?: string;
};

/** One gateway command call; injectable so tests can stand in for the backend. */
export type FixtureInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function runGit(args: string[], cwd?: string): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
}

async function invoke<T>(
  browserUrl: string,
  authFile: string,
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const auth = JSON.parse(await readFile(authFile, "utf8")) as { token?: unknown };
  if (typeof auth.token !== "string") throw new Error("Gateway authentication file is invalid");
  const response = await fetch(new URL("/__orkestrator/invoke", browserUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const payload = (await response.json()) as { result?: T; error?: string };
  if (!response.ok)
    throw new Error(payload.error ?? `${command} failed with HTTP ${response.status}`);
  return payload.result as T;
}

/** The `create_environment` arguments for one fixture environment. */
export function fixtureEnvironmentArgs(
  projectId: string,
  kind: "local" | "container",
  containerNetwork: "restricted" | "full" = "restricted",
): Record<string, unknown> {
  return {
    projectId,
    name: `fixture-${kind}`,
    networkAccessMode: kind === "container" ? containerNetwork : "restricted",
    environmentType: fixtureEnvironmentType(kind),
  };
}

function fixtureEnvironmentType(kind: "local" | "container"): string {
  return kind === "container" ? "containerized" : "local";
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

/**
 * Whether an earlier start's fixture repository and origin are still on disk.
 * Earlier environments hold both: a container binds `origin.git`, a local
 * worktree's `.git` file points into `test-project/.git/worktrees/`.
 */
export async function fixtureRepositoryIntact(profile: RuntimeProfile): Promise<boolean> {
  const projectPath = path.join(profile.fixtureDir, "test-project");
  const originPath = path.join(profile.fixtureDir, "origin.git");
  return (
    (await exists(path.join(projectPath, ".git"))) && (await exists(path.join(originPath, "HEAD")))
  );
}

/**
 * Seeds the fixture project and its environments. A restart of the same
 * profile reuses what an earlier start seeded: recreating the repository would
 * break that start's container (its origin bind keeps the deleted directory)
 * and local worktree, and a second pair would sit beside the broken one in the
 * sidebar. `dev:reset` is the way to get a pristine fixture.
 */
export async function seedFixture(options: {
  profile: RuntimeProfile;
  templateRoot: string;
  browserUrl: string;
  authFile: string;
  environments: Array<"local" | "container">;
  containerNetwork?: "restricted" | "full";
  invoke?: FixtureInvoke;
}): Promise<string> {
  const call: FixtureInvoke =
    options.invoke ??
    (<T>(command: string, args?: Record<string, unknown>) =>
      invoke<T>(options.browserUrl, options.authFile, command, args));
  const projectPath = path.join(options.profile.fixtureDir, "test-project");
  const originPath = path.join(options.profile.fixtureDir, "origin.git");

  const projects = await call<Project[]>("get_projects");
  let project = projects.find((entry) => entry.localPath === projectPath);
  const reuse = project !== undefined && (await fixtureRepositoryIntact(options.profile));
  if (!reuse) await prepareFixtureRepository(options.profile, options.templateRoot);
  if (!project) {
    project = await call<Project>("add_project", { gitUrl: originPath, localPath: projectPath });
  }

  // Only a reused repository can still hold working environments; after a
  // re-preparation every earlier one points at the deleted copy.
  const existing = reuse
    ? await call<Environment[]>("get_environments", { projectId: project.id })
    : [];
  // Keep identities in Git metadata: recreating the repository discards the old
  // generation automatically, while fixture changes stay out of git status.
  const identitiesPath = path.join(projectPath, ".git", "orkestrator-fixture-environments.json");
  let identities: Record<string, string> = {};
  const hasIdentities = reuse && (await exists(identitiesPath));
  if (hasIdentities) {
    const saved: unknown = JSON.parse(await readFile(identitiesPath, "utf8"));
    if (
      !saved ||
      typeof saved !== "object" ||
      Array.isArray(saved) ||
      Object.entries(saved).some(
        ([key, value]) => !["local", "container"].includes(key) || typeof value !== "string",
      )
    ) {
      throw new Error("Invalid fixture environment identities; use dev:reset or a new profile.");
    }
    identities = saved as Record<string, string>;
  }
  const saveIdentities = async () => {
    const temporary = `${identitiesPath}.tmp`;
    await writeFile(temporary, JSON.stringify(identities), { mode: 0o600 });
    await rename(temporary, identitiesPath);
  };
  // Adopt an unambiguous legacy fixture only. Name suffixes are generated by
  // the backend and cannot tell us which duplicate owns the current repository.
  if (reuse && !hasIdentities) {
    for (const kind of ["local", "container"] as const) {
      const candidates = existing.filter(
        (entry) =>
          entry.environmentType === fixtureEnvironmentType(kind) &&
          new RegExp(`^fixture-${kind}(?:-[0-9]+)?$`).test(entry.name ?? ""),
      );
      if (candidates.length > 1) {
        throw new Error("Ambiguous legacy fixture environments; use dev:reset or a new profile.");
      }
      if (candidates[0]) identities[kind] = candidates[0].id;
    }
  }
  await saveIdentities();
  for (const kind of options.environments) {
    const args = fixtureEnvironmentArgs(project.id, kind, options.containerNetwork);
    const previous = existing.find(
      (entry) =>
        entry.id === identities[kind] && entry.environmentType === fixtureEnvironmentType(kind),
    );
    if (
      kind === "container" &&
      previous &&
      (previous.networkAccessMode ?? "restricted") !== args.networkAccessMode
    ) {
      throw new Error(
        "Fixture container network mode differs from --fixture-network; use dev:reset or a new profile.",
      );
    }
    // Starting a running environment re-runs its setup, so leave it alone.
    if (previous?.status === "running") continue;
    const environment = previous ?? (await call<Environment>("create_environment", args));
    identities[kind] = environment.id;
    await saveIdentities();
    await call("start_environment", { environmentId: environment.id });
  }
  return projectPath;
}

export async function prepareFixtureRepository(
  profile: RuntimeProfile,
  templateRoot: string,
): Promise<string> {
  const projectPath = path.join(profile.fixtureDir, "test-project");
  const originPath = path.join(profile.fixtureDir, "origin.git");
  await rm(projectPath, { recursive: true, force: true });
  await rm(originPath, { recursive: true, force: true });
  await mkdir(profile.fixtureDir, { recursive: true, mode: 0o700 });
  await cp(templateRoot, projectPath, { recursive: true });

  runGit(["init", "--bare", originPath]);
  runGit(["init", "-b", "main"], projectPath);
  runGit(["-C", projectPath, "config", "user.name", "Orkestrator Test Fixture"]);
  runGit(["-C", projectPath, "config", "user.email", "fixture@invalid.local"]);
  runGit(["-C", projectPath, "add", "."]);
  runGit(["-C", projectPath, "commit", "-m", "Initial deterministic fixture"]);
  runGit(["-C", projectPath, "remote", "add", "origin", originPath]);
  runGit(["-C", projectPath, "push", "-u", "origin", "main"]);
  return projectPath;
}
