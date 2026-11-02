import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../../electron/runtime-profile.js";
import {
  type FixtureInvoke,
  fixtureEnvironmentArgs,
  prepareFixtureRepository,
  seedFixture,
} from "./fixture.js";

const directories: string[] = [];

afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  ),
);

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (status !== 0) throw new Error(stderr);
  return stdout.trim();
}

const template = path.resolve(import.meta.dirname, "../../../../test-fixtures/agent-project");

async function temporaryProfile() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-fixture-"));
  directories.push(root);
  return resolveRuntimeProfile({
    repositoryRoot: path.join(root, "repo"),
    requestedId: "fixture-test",
    roots: {
      developmentRoot: path.join(root, "profiles"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    },
  });
}

type FakeEnvironment = {
  id: string;
  projectId: string;
  name: string;
  environmentType: string;
  status: string;
  networkAccessMode: string;
};

/** An in-memory backend answering the gateway commands `seedFixture` sends. */
function fakeBackend() {
  const projects: Array<{ id: string; localPath: string }> = [];
  const environments: FakeEnvironment[] = [];
  const calls: string[] = [];
  const invoke: FixtureInvoke = async <T>(command: string, args: Record<string, unknown> = {}) => {
    calls.push(command);
    switch (command) {
      case "get_projects":
        return projects.map((project) => ({ ...project })) as T;
      case "add_project": {
        const project = { id: `project-${projects.length + 1}`, localPath: String(args.localPath) };
        projects.push(project);
        return { ...project } as T;
      }
      case "get_environments":
        return environments
          .filter((environment) => environment.projectId === args.projectId)
          .map((environment) => ({ ...environment })) as T;
      case "create_environment": {
        let name = String(args.name);
        let suffix = 1;
        while (environments.some((entry) => entry.name === name))
          name = `${String(args.name)}-${suffix++}`;
        const environment = {
          id: `environment-${environments.length + 1}`,
          projectId: String(args.projectId),
          name,
          networkAccessMode: String(args.networkAccessMode),
          environmentType: String(args.environmentType),
          status: "stopped",
        };
        environments.push(environment);
        return { ...environment } as T;
      }
      case "start_environment": {
        const environment = environments.find((entry) => entry.id === args.environmentId);
        if (!environment) throw new Error(`Environment not found: ${String(args.environmentId)}`);
        environment.status = "running";
        return undefined as T;
      }
      default:
        throw new Error(`Unexpected command ${command}`);
    }
  };
  return { projects, environments, calls, invoke };
}

function seed(
  profile: Awaited<ReturnType<typeof temporaryProfile>>,
  invoke: FixtureInvoke,
  environments: Array<"local" | "container"> = ["local", "container"],
  containerNetwork?: "restricted" | "full",
) {
  return seedFixture({
    profile,
    templateRoot: template,
    browserUrl: "http://127.0.0.1:1",
    authFile: "/nonexistent",
    environments,
    containerNetwork,
    invoke,
  });
}

describe("disposable agent-test fixture", () => {
  test("re-seeds the same commit without modifying the checked-in template", async () => {
    const before = await readFile(path.join(template, "package.json"), "utf8");
    const profile = await temporaryProfile();

    const first = await prepareFixtureRepository(profile, template);
    const firstCommit = await gitOutput(first, "rev-parse", "HEAD");
    await Bun.write(path.join(first, "disposable-change.txt"), "changed\n");
    const second = await prepareFixtureRepository(profile, template);

    expect(second).toBe(first);
    expect(await gitOutput(second, "rev-parse", "HEAD")).toBe(firstCommit);
    expect(await gitOutput(second, "status", "--porcelain")).toBe("");
    expect(await readFile(path.join(template, "package.json"), "utf8")).toBe(before);
  });

  test("a fresh profile prepares the repository, registers it and starts each environment", async () => {
    const profile = await temporaryProfile();
    const backend = fakeBackend();

    const projectPath = await seed(profile, backend.invoke);

    expect(projectPath).toBe(path.join(profile.fixtureDir, "test-project"));
    expect(await gitOutput(projectPath, "status", "--porcelain")).toBe("");
    expect(backend.projects).toEqual([{ id: "project-1", localPath: projectPath }]);
    expect(backend.calls).toEqual([
      "get_projects",
      "add_project",
      "create_environment",
      "start_environment",
      "create_environment",
      "start_environment",
    ]);
    expect(backend.environments.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: "fixture-local", status: "running" },
      { name: "fixture-container", status: "running" },
    ]);
  });

  test("a restart reuses the fixture so earlier environments keep working", async () => {
    const profile = await temporaryProfile();
    const backend = fakeBackend();
    const projectPath = await seed(profile, backend.invoke);
    const originPath = path.join(profile.fixtureDir, "origin.git");
    const originInode = (await stat(originPath)).ino;
    // What the first start's local environment holds: a worktree whose `.git`
    // file points into `test-project/.git/worktrees/`.
    const worktree = path.join(profile.fixtureDir, "earlier-worktree");
    await gitOutput(projectPath, "worktree", "add", "-b", "earlier", worktree);
    await Bun.write(path.join(projectPath, "work-in-progress.txt"), "kept\n");
    // The second start's backend restored the container as stopped.
    backend.environments[1]!.status = "stopped";
    backend.calls.length = 0;

    expect(await seed(profile, backend.invoke)).toBe(projectPath);

    expect(backend.calls).toEqual(["get_projects", "get_environments", "start_environment"]);
    expect(backend.environments).toHaveLength(2);
    expect(backend.environments.every((environment) => environment.status === "running")).toBe(
      true,
    );
    // The origin a container binds is the same directory, not a recreated one.
    expect((await stat(originPath)).ino).toBe(originInode);
    expect(await gitOutput(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("earlier");
    expect(await readFile(path.join(projectPath, "work-in-progress.txt"), "utf8")).toBe("kept\n");
  });

  test("a restart adds only the requested environments an earlier start did not create", async () => {
    const profile = await temporaryProfile();
    const backend = fakeBackend();
    await seed(profile, backend.invoke, ["local"]);
    backend.calls.length = 0;

    await seed(profile, backend.invoke, ["local", "container"]);

    expect(backend.calls).toEqual([
      "get_projects",
      "get_environments",
      "create_environment",
      "start_environment",
    ]);
    expect(backend.environments.map(({ name }) => name)).toEqual([
      "fixture-local",
      "fixture-container",
    ]);
  });

  test("a registered project whose repository is gone is prepared again", async () => {
    const profile = await temporaryProfile();
    const backend = fakeBackend();
    const projectPath = await seed(profile, backend.invoke, ["local"]);
    await rm(profile.fixtureDir, { recursive: true, force: true });
    backend.calls.length = 0;

    expect(await seed(profile, backend.invoke, ["local"])).toBe(projectPath);

    expect(await gitOutput(projectPath, "status", "--porcelain")).toBe("");
    // The project stays registered; the environment that pointed at the
    // deleted copy is not reused.
    expect(backend.calls).toEqual(["get_projects", "create_environment", "start_environment"]);
    expect(backend.projects).toHaveLength(1);
    expect(backend.environments[1]!.name).toBe("fixture-local-1");
    backend.environments[1]!.status = "stopped";
    backend.calls.length = 0;
    await seed(profile, backend.invoke, ["local"]);
    expect(backend.environments).toHaveLength(2);
    expect(backend.environments[1]!.status).toBe("running");
    expect(backend.calls).toEqual(["get_projects", "get_environments", "start_environment"]);
  });

  test("rejects ambiguous legacy duplicates without starting or creating environments", async () => {
    const profile = await temporaryProfile();
    const backend = fakeBackend();
    const projectPath = await seed(profile, backend.invoke, ["local"]);
    await rm(path.join(projectPath, ".git", "orkestrator-fixture-environments.json"));
    backend.environments.push({
      ...backend.environments[0]!,
      id: "duplicate",
      name: "fixture-local-1",
    });
    backend.calls.length = 0;
    await expect(seed(profile, backend.invoke, ["local"])).rejects.toThrow("Ambiguous legacy");
    expect(backend.calls).toEqual(["get_projects", "get_environments"]);
  });

  test("adopts a single legacy environment and persists its identity", async () => {
    const profile = await temporaryProfile();
    const backend = fakeBackend();
    const projectPath = await seed(profile, backend.invoke, ["local"]);
    await rm(path.join(projectPath, ".git", "orkestrator-fixture-environments.json"));
    backend.environments[0]!.name = "fixture-local-1";
    await seed(profile, backend.invoke, ["local"]);
    expect(backend.environments).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(
          path.join(projectPath, ".git", "orkestrator-fixture-environments.json"),
          "utf8",
        ),
      ),
    ).toEqual({ local: backend.environments[0]!.id });
  });

  for (const original of ["full", "restricted"] as const) {
    test(`rejects changing a ${original} fixture container network mode`, async () => {
      const profile = await temporaryProfile();
      const backend = fakeBackend();
      await seed(profile, backend.invoke, ["container"], original);
      backend.calls.length = 0;
      await expect(
        seed(profile, backend.invoke, ["container"], original === "full" ? "restricted" : "full"),
      ).rejects.toThrow("network mode differs");
      expect(backend.calls).toEqual(["get_projects", "get_environments"]);
      expect(backend.environments[0]!.networkAccessMode).toBe(original);
      await seed(profile, backend.invoke, ["container"], original);
      expect(backend.environments).toHaveLength(1);
    });
  }

  test("creates a restricted fixture container unless full network is requested", () => {
    expect(fixtureEnvironmentArgs("project", "container")).toEqual({
      projectId: "project",
      name: "fixture-container",
      networkAccessMode: "restricted",
      environmentType: "containerized",
    });
    expect(fixtureEnvironmentArgs("project", "container", "full").networkAccessMode).toBe("full");
    // The mode only applies to containers; a local environment has no firewall.
    expect(fixtureEnvironmentArgs("project", "local", "full")).toEqual({
      projectId: "project",
      name: "fixture-local",
      networkAccessMode: "restricted",
      environmentType: "local",
    });
  });
});
