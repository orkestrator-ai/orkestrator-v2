/**
 * Real-Docker qualification for container MCP delivery (todo 0040): the
 * entrypoint's Cursor copy, the narrow container writer, and the environment
 * overlay across a real stop and start and a replacement container.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>
 * built from this tree (`staged-inputs` 2 or later for the Cursor case).
 *
 * Every container carries `orkestrator-qualification=<run>`; `afterAll`
 * removes exactly those. Inputs are mounted from a private temporary
 * directory standing in for the backend's staged revision, so nothing reads
 * or writes the operator's own configuration.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  probeContainerMcpPaths,
  readContainerBootId,
  readContainerMcpFile,
  writeContainerMcpFile,
} from "../src/core/commands-registry-mcp";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { DOCKER_LABEL_INPUTS_REVISION } from "../src/core/constants";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import {
  ensureStorageVolumes,
  initializeStorageSet,
  planStorageSet,
} from "../src/core/container-storage";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";
import { McpManagementService } from "../src/core/mcp-management/service";
import { contentDigest } from "../src/core/mcp-management/source-store";
import { runCommand } from "../src/core/shell";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const RUN = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const RUN_LABEL = `orkestrator-qualification=${RUN}`;
const LIVE_TIMEOUT_MS = 240_000;

const CODEX = "/home/node/.codex/config.toml";
const INHERITED = `model = "gpt"\n\n[mcp_servers.inherited]\ncommand = "inherited"\n\n[mcp_servers.other]\ncommand = "other"\n`;

let root = "";
let staged = "";
let owner = "";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

async function exec(id: string, script: string, user = "node"): Promise<string> {
  return docker(["exec", "--user", user, id, "sh", "-c", script]);
}

/** A labelled container on the real entrypoint, with staged inputs mounted read-only. */
async function startContainer(name: string, absentCodex = false): Promise<string> {
  const id = await docker([
    "run",
    "-d",
    "--name",
    `ork-${RUN}-${name}`,
    "--label",
    RUN_LABEL,
    "--cap-add",
    "NET_ADMIN",
    "-e",
    "NETWORK_MODE=full",
    "-e",
    "GIT_URL=https://example.invalid/none.git",
    "--mount",
    `type=bind,src=${path.join(staged, absentCodex ? "empty-codex-home" : "codex-home")},dst=/codex-home,readonly`,
    "--mount",
    `type=bind,src=${path.join(staged, "cursor-config")},dst=/cursor-config,readonly`,
    IMAGE,
  ]);
  await waitForContainerBoot(id);
  return id;
}

async function containerText(id: string, filePath: string): Promise<string | null> {
  const read = await readContainerMcpFile(id, filePath, 1 << 20);
  return read.state === "ok" ? new TextDecoder().decode(read.bytes) : null;
}

beforeAll(async () => {
  if (!ENABLED) return;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-mcp-overlay-live-"));
  owner = dockerOwnerNamespace(path.join(root, "lifecycle-data"));
  staged = path.join(root, "staged");
  await fs.mkdir(path.join(staged, "codex-home"), { recursive: true });
  await fs.mkdir(path.join(staged, "cursor-config"), { recursive: true });
  await fs.mkdir(path.join(staged, "empty-codex-home"), { recursive: true, mode: 0o755 });
  await fs.writeFile(path.join(staged, "codex-home", "config.toml"), INHERITED);
  await fs.writeFile(
    path.join(staged, "cursor-config", "mcp.json"),
    JSON.stringify({ mcpServers: { cursorUser: { url: "https://c.example/mcp" } } }),
  );
  // Never copied: only mcp.json is in the Cursor allowlist.
  await fs.writeFile(path.join(staged, "cursor-config", "auth.json"), "{}");
  // The staged mount is world-readable inside the container, like a real revision.
  await fs.chmod(path.join(staged, "codex-home"), 0o755);
  await fs.chmod(path.join(staged, "cursor-config"), 0o755);
  for (const file of [
    "codex-home/config.toml",
    "cursor-config/mcp.json",
    "cursor-config/auth.json",
  ])
    await fs.chmod(path.join(staged, file), 0o644);
});

afterAll(async () => {
  if (!ENABLED) return;
  const ids = (await docker(["ps", "-aq", "--filter", `label=${RUN_LABEL}`]).catch(() => ""))
    .split("\n")
    .filter(Boolean);
  if (ids.length) await docker(["rm", "-f", ...ids]).catch(() => undefined);
  // Backend code under test labels what it creates with this run's private owner.
  for (const kind of ["container", "volume", "network"] as const) {
    const list =
      kind === "container"
        ? ["ps", "-aq", "--filter", `label=orkestrator-owner=${owner}`]
        : [kind, "ls", "-q", "--filter", `label=orkestrator-owner=${owner}`];
    const found = (await docker(list).catch(() => "")).split("\n").filter(Boolean);
    if (!found.length) continue;
    const remove = kind === "container" ? ["rm", "-f"] : [kind, "rm"];
    await docker([...remove, ...found]).catch(() => undefined);
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
}, 120_000);

describe("Cursor delivery and the container writer", () => {
  live(
    "the entrypoint copies only Cursor's mcp.json, owner-only; the writer is narrow",
    async () => {
      const id = await startContainer("writer");
      expect(await exec(id, "stat -c %a /home/node/.cursor/mcp.json")).toBe("600");
      expect(await exec(id, "test -e /home/node/.cursor/auth.json && echo yes || echo no")).toBe(
        "no",
      );
      expect(JSON.parse((await containerText(id, "/home/node/.cursor/mcp.json"))!)).toEqual({
        mcpServers: { cursorUser: { url: "https://c.example/mcp" } },
      });

      const before = new TextEncoder().encode((await containerText(id, CODEX))!);
      const next = new TextEncoder().encode(`${INHERITED}\n[mcp_servers.added]\ncommand = "x"\n`);
      expect(
        await writeContainerMcpFile(id, CODEX, {
          expectedDigest: "sha256:wrong",
          bytes: next,
          mode: "private",
        }),
      ).toEqual({ state: "conflict" });
      expect(
        await writeContainerMcpFile(id, CODEX, {
          expectedDigest: contentDigest(before),
          bytes: next,
          mode: "private",
        }),
      ).toEqual({ state: "ok" });
      expect(await containerText(id, CODEX)).toBe(new TextDecoder().decode(next));
      expect(await exec(id, `stat -c '%a %U' ${CODEX}`)).toBe("600 node");
      // New files get private parents; project files keep a readable mode.
      expect(
        await writeContainerMcpFile(id, "/workspace/.cursor/mcp.json", {
          expectedDigest: "absent",
          bytes: new TextEncoder().encode("{}"),
          mode: "preserve",
        }),
      ).toEqual({ state: "ok" });
      expect(await exec(id, "stat -c %a /workspace/.cursor/mcp.json")).toBe("644");
      // Outside the homes, through a symlink, or a traversal: refused.
      for (const target of ["/tmp/x.json", "/home/node/../root/x.json", "/etc/passwd"]) {
        expect(
          await writeContainerMcpFile(id, target, {
            expectedDigest: "absent",
            bytes: new TextEncoder().encode("{}"),
            mode: "private",
          }),
        ).toEqual({ state: "refused" });
      }
      await exec(id, "ln -s /etc/hostname /home/node/.codex/linked.toml");
      expect(
        await writeContainerMcpFile(id, "/home/node/.codex/linked.toml", {
          expectedDigest: "absent",
          bytes: new TextEncoder().encode(""),
          mode: "private",
        }),
      ).toEqual({ state: "refused" });
      await exec(id, "mkdir -p /tmp/elsewhere && ln -s /tmp/elsewhere /home/node/.linkdir");
      expect(
        await writeContainerMcpFile(id, "/home/node/.linkdir/mcp.json", {
          expectedDigest: "absent",
          bytes: new TextEncoder().encode("{}"),
          mode: "private",
        }),
      ).toEqual({ state: "refused" });
      expect(await exec(id, "test -e /tmp/elsewhere/mcp.json && echo yes || echo no")).toBe("no");

      expect(await readContainerBootId(id)).toMatch(/^[0-9a-f-]{36}$/);
      const paths = await probeContainerMcpPaths(id, ["/usr/bin/env", "/home/node", "/nope/x"]);
      expect(Object.fromEntries(paths!)).toEqual({
        "/usr/bin/env": "file",
        "/home/node": "directory",
        "/nope/x": "absent",
      });
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("environment overlay on a real container", () => {
  live(
    "survives backend restart, stop and start, and a replacement container; edits inside are detected",
    async () => {
      let id = await startContainer("overlay");
      const dataDir = path.join(root, "data");
      const home = path.join(root, "home");
      await fs.mkdir(dataDir, { recursive: true });
      await fs.mkdir(home, { recursive: true });
      const environment: Record<string, unknown> = {
        id: "env-live",
        name: "live",
        projectId: "p",
        createdAt: "2026-10-23T00:00:00Z",
        environmentType: "containerized",
        containerId: id,
        status: "running",
      };
      const newService = () =>
        new McpManagementService({
          dataDir,
          home,
          env: {},
          lockDir: path.join(root, "locks"),
          tickMs: 1_000_000,
          storage: {
            getEnvironment: async (candidate) =>
              (candidate === environment.id ? environment : null) as never,
            getProject: async () => ({ id: "p", name: "p" }) as never,
            getPreviewBackendIdentity: async () => ({ instanceId: "live-backend" }),
          },
          emit: () => undefined,
          probe: {
            environments: async () => [],
            sessions: async () => [],
            activity: () => "idle",
            reloadCodex: async () => "not-running",
            mcpConfigEvidence: async () => ({ state: "not-running" }),
          },
          readContainerFile: readContainerMcpFile,
          writeContainerFile: writeContainerMcpFile,
          readContainerBootId: readContainerBootId,
          probeContainerPaths: probeContainerMcpPaths,
        });
      let service = newService();
      const targetId = (await service.listTargets({ environmentId: "env-live" })).targets.find(
        (target) => target.provider === "codex" && target.context.kind === "environment",
      )!.targetId;
      const snapshot = await service.snapshot({ targetId });
      const user = snapshot.sources.find((source) => source.sourceId === "codex:user")!;
      expect(user).toMatchObject({ writable: true, scope: "environment-private" });
      await service.mutate({
        mutation: {
          requestId: "live-1",
          targetId,
          applyIntent: "save",
          operation: {
            kind: "add",
            sourceId: "codex:user",
            expectedRevision: user.revision,
            definition: { name: "mine", transport: "stdio", command: "mine" },
          },
        },
      });
      const other = (await service.snapshot({ targetId })).definitions.find(
        (definition) => definition.name === "other",
      )!;
      await service.mutate({
        mutation: {
          requestId: "live-2",
          targetId,
          applyIntent: "save",
          operation: {
            kind: "remove",
            entryId: other.entryId,
            expectedRevision: (await service.snapshot({ targetId })).sources.find(
              (source) => source.sourceId === "codex:user",
            )!.revision!,
          },
        },
      });
      const servers = async () =>
        Object.keys(
          (Bun.TOML.parse((await containerText(id, CODEX))!) as { mcp_servers: object })
            .mcp_servers,
        ).sort();
      expect(await servers()).toEqual(["inherited", "mine"]);

      // Backend restart: a new service finds the same record.
      service.dispose();
      service = newService();
      // Real stop and start: the entrypoint copies the staged file again.
      const firstBoot = await readContainerBootId(id);
      await docker(["stop", "-t", "5", id]);
      await docker(["start", id]);
      await waitForContainerBoot(id);
      expect(await readContainerBootId(id)).not.toBe(firstBoot);
      expect(await servers()).toEqual(["inherited", "other"]);
      expect(
        (await service.snapshot({ targetId })).sources.find(
          (source) => source.sourceId === "codex:user",
        )!.overlay?.state,
      ).toBe("pending");
      expect(await service.materialiseEnvironment("env-live")).toBe(1);
      expect(await servers()).toEqual(["inherited", "mine"]);
      expect(await exec(id, `stat -c %a ${CODEX}`)).toBe("600");

      // A replacement container for the same environment (what a rebuild commits).
      await docker(["rm", "-f", id]);
      id = await startContainer("overlay-replacement");
      environment.containerId = id;
      service.dispose();
      service = newService();
      const replacementTarget = (
        await service.listTargets({ environmentId: "env-live" })
      ).targets.find(
        (target) => target.provider === "codex" && target.context.kind === "environment",
      )!.targetId;
      expect(await servers()).toEqual(["inherited", "other"]);
      expect(await service.materialiseEnvironment("env-live")).toBe(1);
      expect(await servers()).toEqual(["inherited", "mine"]);

      // An edit made inside the container is reported, not overwritten.
      await exec(id, `sed -i 's/command = "mine"/command = "edited"/' ${CODEX}`);
      const diverged = (await service.snapshot({ targetId: replacementTarget })).sources.find(
        (source) => source.sourceId === "codex:user",
      )!;
      expect(diverged.overlay).toMatchObject({ state: "diverged", divergedNames: ["mine"] });
      await service.resolveOverlay({
        resolution: {
          targetId: replacementTarget,
          sourceId: "codex:user",
          expectedRevision: diverged.revision,
          action: { kind: "import" },
        },
      });
      await docker(["stop", "-t", "5", id]);
      await docker(["start", id]);
      await waitForContainerBoot(id);
      await service.materialiseEnvironment("env-live");
      expect(await containerText(id, CODEX)).toContain(`command = "edited"`);

      // The staged input (the backend's copy) is byte-for-byte what it was.
      expect(await fs.readFile(path.join(staged, "codex-home", "config.toml"), "utf8")).toBe(
        INHERITED,
      );
      // No staged provider file: stop/start retains our previous output,
      // whereas a replacement container starts with no file at all.
      service.dispose();
      await docker(["rm", "-f", id]);
      id = await startContainer("absent-input", true);
      environment.containerId = id;
      // Keep this scenario independent from the earlier inherited baseline.
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.mkdir(dataDir, { recursive: true });
      service = newService();
      const absentTarget = (await service.listTargets({ environmentId: "env-live" })).targets.find(
        (t) => t.provider === "codex" && t.context.kind === "environment",
      )!.targetId;
      expect(await containerText(id, CODEX)).toBeNull();
      await service.mutate({
        mutation: {
          requestId: "absent-add",
          targetId: absentTarget,
          applyIntent: "save",
          operation: {
            kind: "add",
            sourceId: "codex:user",
            expectedRevision: null,
            definition: { name: "private", transport: "stdio", command: "private" },
          },
        },
      });
      await docker(["stop", "-t", "5", id]);
      await docker(["start", id]);
      await waitForContainerBoot(id);
      expect(await containerText(id, CODEX)).toContain('command = "private"');
      expect(await service.materialiseEnvironment("env-live")).toBe(1);
      expect(
        (await service.snapshot({ targetId: absentTarget })).sources.find(
          (s) => s.sourceId === "codex:user",
        )!.overlay?.added,
      ).toEqual(["private"]);
      await docker(["rm", "-f", id]);
      id = await startContainer("absent-replacement", true);
      environment.containerId = id;
      expect(await containerText(id, CODEX)).toBeNull();
      expect(await service.materialiseEnvironment("env-live")).toBe(1);
      const recovered = (await service.snapshot({ targetId: absentTarget })).sources.find(
        (s) => s.sourceId === "codex:user",
      )!;
      expect(recovered.overlay?.added).toEqual(["private"]);
      expect(await containerText(id, CODEX)).toContain('command = "private"');
      await service.resolveOverlay({
        resolution: {
          targetId: absentTarget,
          sourceId: "codex:user",
          expectedRevision: recovered.revision,
          action: { kind: "reset" },
        },
      });
      expect(
        (Bun.TOML.parse((await containerText(id, CODEX))!) as { mcp_servers?: object })
          .mcp_servers ?? {},
      ).toEqual({});
      service.dispose();
    },
    LIVE_TIMEOUT_MS * 2,
  );
});

describe("a real rebuild re-stages the backend user's inputs", () => {
  live(
    "a rebuild creates its candidate from freshly staged inputs; in-container edits do not survive",
    async () => {
      const { createDockerContainer } = await import("../src/core/commands-containers");
      const { replaceRuntimePreservingState } = await import("../src/core/container-replacement");
      const { resolveDockerImage } = await import("../src/core/docker-image");
      const codexHome = path.join(root, "host-codex");
      await fs.mkdir(codexHome, { recursive: true });
      const hostConfig = (version: string) => `[mcp_servers.host]\ncommand = "host-${version}"\n`;
      await fs.writeFile(path.join(codexHome, "config.toml"), hostConfig("v1"));
      const previousCodexHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = codexHome;
      try {
        const lifecycleData = path.join(root, "lifecycle-data");
        await fs.mkdir(lifecycleData, { recursive: true });
        const environment = lifecycleEnvironment({
          id: `env-${RUN}-rebuild`,
          networkAccessMode: "full",
        });
        const fixture = memoryLifecycleContext([environment], lifecycleData);
        Object.assign(fixture.context, {
          dockerImage: IMAGE,
          runtimeFlavor: "agent-test",
          credentialSources: new Set(["codex"]),
        });
        Object.assign(fixture.context.storage, {
          getProject: async () => ({
            id: "project-1",
            name: "Project",
            gitUrl: "https://example.invalid/none.git",
            localPath: null,
            addedAt: new Date(0).toISOString(),
            order: 0,
          }),
          loadConfig: async () => ({
            version: "1.0.0",
            global: { allowedDomains: [], enabledAgentPlatforms: ["codex"] },
            repositories: {},
          }),
          listMultiReviewWorkflows: async () => [],
          listAllBuildPipelines: async () => [],
        });
        const resolved = await resolveDockerImage(IMAGE);
        if (resolved.kind !== "present") throw new Error("qualification image missing");
        // A persistent-workspace environment, so the first replacement is a rebuild.
        const storage = planStorageSet(environment.id, owner, 1);
        await ensureStorageVolumes(fixture.context, environment.id, storage);
        const initialized = await initializeStorageSet(
          fixture.context,
          resolved.imageId,
          environment.id,
          storage,
        );
        expect(initialized.ok).toBe(true);
        const first = await createDockerContainer(environment, fixture.context, {
          imageId: resolved.imageId,
          runtimeGeneration: 1,
          storage,
        });
        await docker(["start", first]);
        await waitForContainerBoot(first);
        await fixture.context.storage.updateEnvironment(environment.id, {
          containerId: first,
          status: "running",
          containerLifecycle: {
            schemaVersion: 1,
            revision: 1,
            lastRuntimeGeneration: 1,
            runtime: {
              containerId: first,
              runtimeGeneration: 1,
              owner,
              imageRef: IMAGE,
              imageId: resolved.imageId,
            },
            storage,
            outcomes: [],
          },
        });
        expect(await containerText(first, CODEX)).toBe(hostConfig("v1"));
        const label = (id: string) =>
          docker([
            "inspect",
            "-f",
            `{{ index .Config.Labels "${DOCKER_LABEL_INPUTS_REVISION}" }}`,
            id,
          ]);
        const firstRevision = await label(first);

        // This environment's own server, saved through the overlay.
        const service = new McpManagementService({
          dataDir: lifecycleData,
          home: path.join(root, "rebuild-home"),
          env: {},
          lockDir: path.join(root, "rebuild-locks"),
          tickMs: 1_000_000,
          storage: {
            getEnvironment: (id) => fixture.context.storage.getEnvironment(id),
            getProject: async () => ({ id: "project-1", name: "Project" }) as never,
            getPreviewBackendIdentity: async () => ({ instanceId: "live-rebuild" }),
          },
          emit: () => undefined,
          probe: {
            environments: async () => [],
            sessions: async () => [],
            activity: () => "idle",
            reloadCodex: async () => "not-running",
            mcpConfigEvidence: async () => ({ state: "not-running" }),
          },
          readContainerFile: readContainerMcpFile,
          writeContainerFile: writeContainerMcpFile,
          readContainerBootId: readContainerBootId,
        });
        Object.assign(fixture.context, { mcpManagement: service });
        const targetId = (
          await service.listTargets({ environmentId: environment.id })
        ).targets.find(
          (target) => target.provider === "codex" && target.context.kind === "environment",
        )!.targetId;
        const user = (await service.snapshot({ targetId })).sources.find(
          (source) => source.sourceId === "codex:user",
        )!;
        await service.mutate({
          mutation: {
            requestId: "rebuild-1",
            targetId,
            applyIntent: "save",
            operation: {
              kind: "add",
              sourceId: "codex:user",
              expectedRevision: user.revision,
              definition: { name: "mine", transport: "stdio", command: "mine" },
            },
          },
        });
        // An unrecorded edit made only inside the container.
        await exec(first, `printf '# edited inside\\n' >> ${CODEX}`);

        await fixture.context.storage.updateEnvironment(environment.id, { status: "running" });
        await fs.writeFile(path.join(codexHome, "config.toml"), hostConfig("v3"));
        const rebuilt = await replaceRuntimePreservingState(
          { environmentId: environment.id, expectedContainerId: first },
          fixture.context,
        );
        expect(rebuilt?.kind).toBe("rebuild");
        expect(await label(rebuilt!.containerId)).not.toBe(firstRevision);
        // The real start path: boot, then this environment's overlay on top.
        const { startAssignedContainerRuntimeTask } =
          await import("../src/core/commands-environment");
        await startAssignedContainerRuntimeTask(environment.id, fixture.context);
        const text = (await containerText(rebuilt!.containerId, CODEX))!;
        // Current host defaults plus the recorded server; the unrecorded edit is gone.
        expect(Bun.TOML.parse(text)).toEqual({
          mcp_servers: { host: { command: "host-v3" }, mine: { command: "mine" } },
        });
        expect(text).not.toContain("edited inside");
        service.dispose();
      } finally {
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
      }
    },
    LIVE_TIMEOUT_MS * 3,
  );
});
