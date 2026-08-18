import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { RuntimeProfile } from "../../electron/runtime-profile.js";

type Project = { id: string };
type Environment = { id: string };

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

export async function seedFixture(options: {
  profile: RuntimeProfile;
  templateRoot: string;
  browserUrl: string;
  authFile: string;
  environments: Array<"local" | "container">;
}): Promise<string> {
  const projectPath = await prepareFixtureRepository(options.profile, options.templateRoot);
  const originPath = path.join(options.profile.fixtureDir, "origin.git");

  const projects = await invoke<Project[]>(options.browserUrl, options.authFile, "get_projects");
  let project = projects.find(
    (entry) => (entry as Project & { localPath?: string }).localPath === projectPath,
  );
  if (!project) {
    project = await invoke<Project>(options.browserUrl, options.authFile, "add_project", {
      gitUrl: originPath,
      localPath: projectPath,
    });
  }

  for (const kind of options.environments) {
    const environment = await invoke<Environment>(
      options.browserUrl,
      options.authFile,
      "create_environment",
      {
        projectId: project.id,
        name: `fixture-${kind}`,
        networkAccessMode: "restricted",
        environmentType: kind === "container" ? "containerized" : "local",
      },
    );
    await invoke(options.browserUrl, options.authFile, "start_environment", {
      environmentId: environment.id,
    });
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
