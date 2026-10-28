/**
 * Real Docker upgrade qualification in a disposable packaged backend/profile.
 * Run after build:all (uses its packaged runtime assets):
 *   mise run test:logged -- --name preview-upgrade -- bun scripts/qualify-preview-worker-upgrade.ts
 * No production tags, data directories, ports or processes are used.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ArtifactPrepareWorkerResponse,
  MermaidRenderResponse,
  TranscriptArtifactCapabilities,
} from "@orkestrator/protocol/transcript-artifact-commands";
import { DEFAULT_PREVIEW_WORKER_IMAGE } from "../apps/backend/src/core/transcript-artifacts/runtime";
import {
  WORKER_CONTEXT_LABEL,
  workerContextDigest,
} from "../apps/backend/src/core/transcript-artifacts/preview-worker-context-digest";
import {
  PREVIEW_CONTAINER_LABEL,
  PREVIEW_CONTAINER_OWNER_LABEL,
  previewContainerOwner,
} from "../apps/backend/src/core/transcript-artifacts/preview-supervisor";

const root = path.resolve(import.meta.dir, "..");
const scratch = await mkdtemp(path.join(tmpdir(), "ork-preview-upgrade-"));
const packaged = path.join(scratch, "package");
const dataDir = path.join(scratch, "data");
const tag = `orkestrator-artifact-preview-worker:qualification-${randomUUID()}`;
const oldTag = `${tag}-previous`;
const docker = Bun.which("docker");
assert(docker, "Docker CLI is required");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
let backend: Bun.Subprocess | undefined;
let orphan: string | undefined;

async function command(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${argv[0]} ${argv[1]} failed: ${stderr.slice(-2000)}`);
  return stdout.trim();
}
async function stop() {
  const child = backend;
  backend = undefined;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}
// Reserve ephemeral ports; each backend restart uses the same private profile.
function freePort(): number {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = listener.port!;
  listener.stop(true);
  return port;
}
const port = freePort();
const controlPort = freePort();
async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const { token } = JSON.parse(await readFile(path.join(dataDir, "gateway-auth.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${port}/__orkestrator/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(180_000),
  });
  assert(response.ok, `${command}: HTTP ${response.status}`);
  return ((await response.json()) as { result: T }).result;
}
async function start(): Promise<TranscriptArtifactCapabilities> {
  backend = Bun.spawn(
    [
      process.execPath,
      path.join(packaged, "main.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--allow-non-tailscale-bind",
      "--data-dir",
      dataDir,
      "--control-port",
      String(controlPort),
    ],
    {
      cwd: packaged,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("ORKESTRATOR_")),
        ),
        HOME: path.join(scratch, "home"),
        XDG_CONFIG_HOME: path.join(scratch, "config"),
        XDG_CACHE_HOME: path.join(scratch, "cache"),
        XDG_STATE_HOME: path.join(scratch, "state"),
        ORKESTRATOR_DATA_DIR: dataDir,
        ORKESTRATOR_CONTROL_MCP_PORT: String(controlPort),
        ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: path.join(scratch, "docker"),
      },
      // The backend owns a private log; never print gateway credentials or logs.
      stdout: Bun.file(path.join(scratch, "backend.log")),
      stderr: Bun.file(path.join(scratch, "backend.stderr.log")),
    },
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assert.equal(backend.exitCode, null, "packaged backend exited at startup");
    try {
      return await invoke<TranscriptArtifactCapabilities>("transcript_artifact_capabilities");
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error("Packaged backend did not start within 60s");
}

try {
  await mkdir(packaged);
  // Reuse verified release assets, but bundle the changed backend into the
  // disposable package so this exercises the current code outside a checkout.
  for (const dir of ["artifact-runtime", "node_modules"])
    await cp(path.join(root, "apps/backend/dist", dir), path.join(packaged, dir), {
      recursive: true,
    });
  const build = await Bun.build({
    entrypoints: [path.join(root, "apps/backend/src/main.ts")],
    outdir: packaged,
    target: "bun",
    external: ["sharp", "playwright-core"],
  });
  assert(build.success, "packaged backend bundle failed");
  const context = path.join(packaged, "artifact-runtime/worker-context");
  const digest = await workerContextDigest(context);
  // The previous version's local build had no context label or contextDigest
  // pin. Build those exact shipped worker bytes using its Docker arguments.
  await command([docker, "build", "--quiet", "--pull=false", "-t", tag, context]);
  const oldId = await command([docker, "image", "inspect", "--format", "{{.Id}}", tag]);
  await command([docker, "tag", oldId, oldTag]);
  const pin = path.join(dataDir, "artifact-preview-worker/image-pin.json");
  await mkdir(path.dirname(pin), { recursive: true });
  await writeFile(pin, JSON.stringify({ tag: DEFAULT_PREVIEW_WORKER_IMAGE, id: oldId }));
  // Redirect only the default tag to our private tag. Every call still reaches
  // real Docker; id pins, owner labels and container execution are unchanged.
  await writeFile(
    path.join(scratch, "docker"),
    `#!/usr/bin/env bash
set -eu
args=()
for arg do
  if [[ "$arg" == ${quote(DEFAULT_PREVIEW_WORKER_IMAGE)} ]]; then arg=${quote(tag)}; fi
  args+=("$arg")
done
printf '%s\\n' "\${args[*]}" >>${quote(path.join(scratch, "docker.calls"))}
exec ${quote(docker)} "\${args[@]}" 2>>${quote(path.join(scratch, "docker.stderr.log"))}
`,
  );
  await chmod(path.join(scratch, "docker"), 0o755);
  orphan = await command([
    docker,
    "run",
    "-d",
    "--network",
    "none",
    "--label",
    `${PREVIEW_CONTAINER_LABEL}=1`,
    "--label",
    `${PREVIEW_CONTAINER_OWNER_LABEL}=${previewContainerOwner(dataDir)}`,
    "--entrypoint",
    "sleep",
    oldId,
    "300",
  ]);
  const stale = await start();
  assert.equal(stale.previewRenderer.isolation, "process");
  assert.equal(stale.previewRenderer.interactiveIsolation, "unavailable");
  assert.equal(stale.workerPreparation?.outdated, true);
  assert.equal(stale.workerPreparation.available, true);
  assert.equal(await command([docker, "ps", "-aq", "--filter", `id=${orphan}`]), "");
  console.log(
    "PASS packaged startup: stale fallback, visible preparation status, owned orphan removed",
  );

  const prepared = await invoke<ArtifactPrepareWorkerResponse>(
    "transcript_artifact_prepare_worker",
  );
  assert.equal(prepared.state, "ready");
  assert.equal(prepared.method, "build");
  assert.equal(prepared.isolation, "container");
  assert.equal(prepared.outdated, undefined);
  assert.notEqual(prepared.image, oldId);
  const newId = prepared.image!;
  assert.deepEqual(JSON.parse(await readFile(pin, "utf8")), {
    tag: DEFAULT_PREVIEW_WORKER_IMAGE,
    id: newId,
    contextDigest: digest,
  });
  assert.equal(
    await command([
      docker,
      "image",
      "inspect",
      "--format",
      `{{index .Config.Labels "${WORKER_CONTEXT_LABEL}"}}`,
      newId,
    ]),
    digest,
  );
  // Probe is asynchronous after runner replacement. Poll the authoritative
  // capabilities until ready, then require real container rendering.
  async function render(source: string) {
    const deadline = Date.now() + 30_000;
    while (
      !(await invoke<TranscriptArtifactCapabilities>("transcript_artifact_capabilities"))
        .previewRenderer.available
    ) {
      assert(Date.now() < deadline, "container renderer did not become available");
      await Bun.sleep(200);
    }
    const result = await invoke<MermaidRenderResponse>("transcript_artifact_render_mermaid", {
      source,
      theme: "light",
    });
    assert(
      result.ok,
      result.ok ? "" : `${result.error.code}: ${result.error.message.slice(0, 1000)}`,
    );
    assert(result.svgBytes > 0);
  }
  console.log(
    "PASS preparation: different image id, persisted context pin and matching image label",
  );
  const renderFailures: string[] = [];
  async function checkRender(source: string) {
    try {
      await render(source);
    } catch (error) {
      renderFailures.push(error instanceof Error ? error.message : "render failed");
    }
  }
  await checkRender("flowchart TD\n Before-->After");
  await stop();
  const restarted = await start();
  assert.equal(restarted.previewRenderer.interactiveIsolation, "container");
  assert.equal(restarted.workerPreparation?.outdated, undefined);
  assert.equal((JSON.parse(await readFile(pin, "utf8")) as { id: string }).id, newId);
  console.log("PASS packaged restart: current pinned image reused without preparing again");
  await checkRender("flowchart TD\n Restart-->Reused");
  const launches = (await readFile(path.join(scratch, "docker.calls"), "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("run ") && line.endsWith(newId));
  assert(launches.length >= 2, "both packaged starts must launch the newly pinned image");
  assert.deepEqual(
    renderFailures,
    [],
    "real container rendering must succeed before and after restart",
  );
  console.log("PASS real container rendering before and after packaged restart");
} finally {
  await stop();
  if (orphan) await command([docker, "rm", "-f", orphan]);
  await command([docker, "image", "rm", tag, oldTag]);
  if (process.argv.includes("--keep")) console.log(`Private qualification evidence: ${scratch}`);
  else await rm(scratch, { recursive: true, force: true });
}
