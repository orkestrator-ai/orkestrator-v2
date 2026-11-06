/**
 * Real-Docker qualification that the agent CLIs need none of the telemetry
 * hosts the default allowlist used to carry (`sentry.io`,
 * `statsig.anthropic.com`, `statsig.com`; to-do 6100, security finding M12).
 *
 * A restricted runtime of the qualification image, behind its egress gateway
 * with name checks, gets an allowlist that omits all three. Each CLI the image
 * ships that can be given a local provider then runs a real turn against a
 * fake one on the runtime's own loopback, so no provider is called and nothing
 * is billed: Claude Code in print mode, in the stream-json mode the Agent SDK
 * drives (the native tab) and on a provider error, Codex on a reply and on a
 * provider error, OpenCode and Pi. Grok and Cursor are not covered (to-do
 * 7420). Claude's nonessential traffic is left on, as the backend leaves it in
 * a real container. A turn has to finish as expected and within a bound, so a
 * CLI that stalls on a refused host fails.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>.
 * ORKESTRATOR_TELEMETRY_HOSTS_TRACE=<file> also starts a packet reader in the
 * gateway's namespace (a labelled sidecar, not the gateway) and writes to that
 * file, as JSON, each turn's duration, the requests the fake provider served,
 * and every name the namespace looked up and every outside address it tried.
 * That is how the to-do's findings were recorded.
 *
 * Every resource is labelled with this run's private owner namespace and
 * removed by that label afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/core/shell";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { networkOwnerContainer } from "../src/core/container-network-owner";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";
import { removeLabelledResources } from "./container-live-cleanup";
import { startRuntime } from "./container-live-start";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const TRACE = process.env.ORKESTRATOR_TELEMETRY_HOSTS_TRACE?.trim() ?? "";
const live = ENABLED ? test : test.skip;
const RUN = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const LIVE_TIMEOUT_MS = 900_000;
/** The hosts to-do 6100 removed from the default list. */
const TELEMETRY_HOSTS = ["sentry.io", "statsig.anthropic.com", "statsig.com"];
/** The DSN hosts Claude Code, Codex and Grok report to (found in their binaries). */
const SENTRY_INGEST_HOSTS = [
  "o1158394.ingest.us.sentry.io",
  "o33249.ingest.us.sentry.io",
  "o4508179396558848.ingest.us.sentry.io",
];
const PORT = 18300;
const PROBE = "/tmp/telemetry-probe";
/** A turn that waits on a refused host for longer than this has stalled. */
const TURN_SECONDS = 90;

let dataDir = "";
let owner = "";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

beforeAll(async () => {
  if (!ENABLED) return;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-telemetry-hosts-"));
  owner = dockerOwnerNamespace(dataDir);
});

afterAll(async () => {
  if (!ENABLED) return;
  const leftovers = await removeLabelledResources(docker, [`label=orkestrator-owner=${owner}`]);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  expect(leftovers).toEqual([]);
}, 180_000);

/**
 * A fake provider for every CLI: Anthropic Messages under `/anthropic`, and
 * OpenAI Chat Completions and Responses under `/openai/v1`. Each answers with
 * the one word "ok", streamed when asked. Under `/broken` every request fails
 * with a 500, for the turns that end on a provider error. It keeps per-route
 * counts only.
 */
const FAKE_PROVIDER = String.raw`
const counts = {};
const count = (key) => (counts[key] = (counts[key] ?? 0) + 1);
const sse = (events) =>
  new Response(events.map(([event, data]) => "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n").join(""), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
const chat = (lines) =>
  new Response(lines.map((data) => "data: " + JSON.stringify(data) + "\n\n").join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.argv[2]),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/count") return Response.json(counts);
    if (url.pathname.startsWith("/broken/")) {
      count("broken");
      return Response.json(
        { type: "error", error: { type: "api_error", message: "fake provider failure" } },
        { status: 500 },
      );
    }
    let body = {};
    if (request.method === "POST") {
      try { body = JSON.parse(await request.text()); } catch {}
    }
    const usage = { input_tokens: 1, output_tokens: 1 };
    if (url.pathname.startsWith("/anthropic/v1/messages")) {
      if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 1 });
      count("anthropic");
      const message = {
        id: "msg_fake", type: "message", role: "assistant", model: body.model ?? "claude-fake",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage,
      };
      if (body.stream !== true) return Response.json(message);
      return sse([
        ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    }
    if (url.pathname.endsWith("/models")) {
      count("models");
      return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", created: 0, owned_by: "fake" }] });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      count("chat");
      const id = "chatcmpl-fake", created = Math.floor(Date.now() / 1000), model = body.model ?? "fake-model";
      const tokens = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (body.stream !== true)
        return Response.json({ id, object: "chat.completion", created, model, usage: tokens,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
      const chunk = (delta, finish, extra = {}) =>
        ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
      return chat([chunk({ role: "assistant", content: "ok" }, null), chunk({}, "stop", { usage: tokens })]);
    }
    if (url.pathname.endsWith("/responses")) {
      count("responses");
      const id = "resp_fake";
      const item = { type: "message", id: "msg_fake", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }] };
      return sse([
        ["response.created", { type: "response.created", response: { id } }],
        ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
        ["response.completed", { type: "response.completed", response: { id, output: [item], usage: {
          input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } }],
      ]);
    }
    count("unserved");
    return new Response("not served", { status: 404 });
  },
});
`;

/**
 * Prints each DNS question and each outside TCP connection attempt seen in
 * the namespace, as `dns <name>` and `connect <address>:<port>`. Docker's
 * embedded resolver and the gateway's own lookups are included, so the trace
 * is read for names, not attributed to one process.
 */
const PACKET_TRACE = String.raw`
use strict; use warnings; use Socket;
socket(my $s, 17, 3, 0x0300) or die "packet socket: $!";
$| = 1;
while (1) {
  defined(recv($s, my $frame, 65535, 0)) or next;
  next unless length($frame) > 34 && unpack('n', substr($frame, 12, 2)) == 0x0800;
  my $ip = substr($frame, 14);
  my $ihl = (unpack('C', $ip) & 15) * 4;
  my $protocol = unpack('C', substr($ip, 9, 1));
  my $destination = join('.', unpack('C4', substr($ip, 16, 4)));
  my $l4 = substr($ip, $ihl);
  my ($source_port, $port) = unpack('nn', $l4);
  if ($protocol == 17 && ($port == 53 || $port == 31453)) {
    my $dns = substr($l4, 8);
    next if (unpack('n', substr($dns, 2, 2)) & 0x8000);
    my ($offset, @labels) = (12);
    while ($offset < length($dns)) {
      my $length = unpack('C', substr($dns, $offset, 1));
      last if !$length || $length > 63;
      push @labels, substr($dns, $offset + 1, $length);
      $offset += $length + 1;
    }
    print 'dns ', join('.', @labels), "\n" if @labels;
  } elsif ($protocol == 6 && $destination !~ /^127\./) {
    my $flags = unpack('C', substr($l4, 13, 1));
    print "connect $destination:$port\n" if ($flags & 0x02) && !($flags & 0x10);
  }
}
`;

/**
 * Runs a shell command as node in the runtime's probe directory: its output
 * (stdout and stderr), then `rc=<status>` on a line of its own.
 */
async function inRuntime(
  containerId: string,
  script: string,
  env: Record<string, string> = {},
): Promise<string> {
  return docker(
    [
      "exec",
      "-u",
      "node",
      "-w",
      PROBE,
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      containerId,
      "bash",
      "-c",
      `out=$( ${script} 2>&1 ); rc=$?; printf '%s\\nrc=%s' "$out" "$rc"`,
    ],
    (TURN_SECONDS + 30) * 1000,
  );
}

/** Writes `content` to a runtime path as node. */
async function write(containerId: string, file: string, content: string): Promise<void> {
  await docker([
    "exec",
    "-u",
    "node",
    containerId,
    "sh",
    "-c",
    `mkdir -p "$(dirname "${file}")" && printf %s '${Buffer.from(content).toString("base64")}' | base64 -d > "${file}"`,
  ]);
}

async function createRuntime(allowedDomains: string[]) {
  const { createDockerContainer } = await import("../src/core/commands-containers");
  const { resolveDockerImage } = await import("../src/core/docker-image");
  const environment = lifecycleEnvironment({
    id: `env-${RUN}`,
    networkAccessMode: "restricted",
    allowedDomains,
  });
  const fixture = memoryLifecycleContext([environment], dataDir);
  Object.assign(fixture.context, { runtimeFlavor: "agent-test", credentialSources: new Set() });
  Object.assign(fixture.context.storage, {
    getProject: async () => ({
      id: "project-1",
      name: "Project",
      // Not a remote URL: the create path runs no host-side Git mirror.
      gitUrl: "file:///nonexistent/none.git",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { allowedDomains, enabledAgentPlatforms: [] },
      repositories: {},
    }),
  });
  const resolved = await resolveDockerImage(IMAGE);
  if (resolved.kind !== "present") throw new Error("qualification image missing");
  const containerId = await createDockerContainer(environment, fixture.context, {
    imageId: resolved.imageId,
    runtimeGeneration: 1,
  });
  await fixture.context.storage.updateEnvironment(environment.id, {
    containerId,
    status: "running",
  });
  return { containerId, gateway: await networkOwnerContainer(containerId) };
}

describe("default allowlist telemetry hosts (to-do 6100)", () => {
  live(
    "every agent CLI finishes a turn against a fake provider without the telemetry hosts",
    async () => {
      // The fake provider is on the runtime's loopback, which is always
      // allowed; one outside host keeps the list from meaning "GitHub only".
      const { containerId, gateway } = await createRuntime(["registry.npmjs.org"]);
      expect(gateway).not.toBe(containerId);
      await startRuntime(containerId);
      await waitForContainerBoot(containerId);
      await docker(["exec", "-u", "node", containerId, "mkdir", "-p", PROBE]);
      let trace: ReturnType<typeof Bun.spawn> | undefined;
      if (TRACE) {
        const network = await docker([
          "inspect",
          "--format",
          "{{.HostConfig.NetworkMode}}",
          containerId,
        ]);
        trace = Bun.spawn(
          [
            "docker",
            "run",
            "--name",
            `ork-${RUN}-trace`,
            "--label",
            `orkestrator-owner=${owner}`,
            "--network",
            network,
            "--user",
            "root",
            "--entrypoint",
            "perl",
            IMAGE,
            "-e",
            PACKET_TRACE,
          ],
          { stdout: "pipe", stderr: "inherit" },
        );
      }
      // Each phase starts with a lookup of a reserved marker name, so the
      // trace can say which turn asked for which name.
      const lines: string[] = [];
      const reading = trace
        ? (async () => {
            let buffered = "";
            for await (const chunk of trace.stdout as ReadableStream<Uint8Array>) {
              buffered += new TextDecoder().decode(chunk);
              const complete = buffered.split("\n");
              buffered = complete.pop() ?? "";
              lines.push(...complete.filter(Boolean));
            }
          })()
        : Promise.resolve();
      const marker = (phase: string) => `orkestrator-mark-${phase}.invalid`;
      const mark = async (phase: string) => {
        if (trace)
          await inRuntime(containerId, `dig +time=1 +tries=1 ${marker(phase)} A > /dev/null`);
      };
      let observed: Awaited<ReturnType<typeof probe>> | undefined;
      try {
        for (let attempt = 0; trace && attempt < 60; attempt++) {
          await mark("ready");
          if (lines.includes(`dns ${marker("ready")}`)) break;
          await Bun.sleep(250);
        }
        observed = await probe(containerId, mark);
      } finally {
        if (trace) {
          await docker(["rm", "-f", `ork-${RUN}-trace`]).catch(() => "");
          await reading;
          const phases: Record<string, string[]> = {};
          let phase = "boot";
          for (const line of lines) {
            const named = /^dns orkestrator-mark-(.+)\.invalid$/.exec(line);
            if (named) phase = named[1]!;
            else if (!(phases[phase] ??= []).includes(line)) phases[phase]!.push(line);
          }
          await fs.writeFile(TRACE, JSON.stringify({ ...observed, phases }, null, 2));
        }
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

/** The turns themselves, in a runtime that has booted. */
async function probe(
  containerId: string,
  mark: (phase: string) => Promise<void>,
): Promise<{ turnMs: Record<string, number>; served: Record<string, number> }> {
  // The gateway refuses every telemetry name, including the DSN hosts.
  await mark("dig-checks");
  for (const host of [...TELEMETRY_HOSTS, ...SENTRY_INGEST_HOSTS]) {
    expect(
      await inRuntime(containerId, `dig +time=3 +tries=1 ${host} A | grep -o 'status: [A-Z]*'`),
    ).toContain("status: REFUSED");
  }

  await write(containerId, `${PROBE}/fake-provider.js`, FAKE_PROVIDER);
  await docker([
    "exec",
    "-d",
    "-u",
    "node",
    containerId,
    "bun",
    `${PROBE}/fake-provider.js`,
    String(PORT),
  ]);
  const counts = async (): Promise<Record<string, number>> => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const answer = await docker([
        "exec",
        containerId,
        "curl",
        "-sf",
        `http://127.0.0.1:${PORT}/count`,
      ]).catch(() => "");
      if (answer.startsWith("{")) return JSON.parse(answer) as Record<string, number>;
      await Bun.sleep(100);
    }
    throw new Error("the fake provider never answered");
  };
  await counts();
  const openai = `http://127.0.0.1:${PORT}/openai/v1`;
  const timed = (command: string) => `timeout ${TURN_SECONDS} ${command}`;
  const results: Record<string, number> = {};
  const turn = async (name: string, script: string, env: Record<string, string> = {}) => {
    await mark(name);
    const started = Date.now();
    const output = await inRuntime(containerId, timed(script), env);
    results[name] = Date.now() - started;
    return output;
  };

  // Claude Code: print mode (a terminal turn), then the stream-json
  // protocol the Agent SDK drives for a native tab. Nonessential traffic
  // and error reporting stay on.
  const claude = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}/anthropic`,
    ANTHROPIC_API_KEY: "sk-ant-fake-not-a-key",
    CLAUDE_CODE_MAX_RETRIES: "0",
  };
  expect(await turn("claude-print", "claude -p 'Reply with ok.'", claude)).toMatch(/^ok\nrc=0$/);
  const message = JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Reply with ok." }] },
  });
  await write(containerId, `${PROBE}/sdk-input.jsonl`, `${message}\n`);
  const sdk = await turn(
    "claude-sdk",
    "claude -p --input-format stream-json --output-format stream-json --verbose < sdk-input.jsonl",
    { ...claude, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
  );
  expect(sdk).toMatch(/rc=0$/);
  const result = sdk
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { type?: string; is_error?: boolean; result?: string })
    .find((event) => event.type === "result");
  expect(result).toMatchObject({ is_error: false, result: "ok" });
  // A turn the provider fails: the path that reports errors. It has to end
  // promptly and say so, not wait on Sentry.
  expect(
    await turn("claude-error", "claude -p 'Reply with ok.'", {
      ...claude,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}/broken/anthropic`,
    }),
  ).toMatch(/\nrc=1$/);

  // Codex against a Responses provider of its own.
  await write(
    containerId,
    `${PROBE}/codex-home/config.toml`,
    [
      'model = "fake-model"',
      'model_provider = "fake"',
      "[model_providers.fake]",
      'name = "fake"',
      `base_url = "${openai}"`,
      'wire_api = "responses"',
      'env_key = "FAKE_API_KEY"',
      "[model_providers.broken]",
      'name = "broken"',
      `base_url = "http://127.0.0.1:${PORT}/broken/openai/v1"`,
      'wire_api = "responses"',
      'env_key = "FAKE_API_KEY"',
      "request_max_retries = 0",
      "stream_max_retries = 0",
    ].join("\n"),
  );
  expect(
    await turn("codex", "codex exec --skip-git-repo-check 'Reply with ok.' < /dev/null", {
      CODEX_HOME: `${PROBE}/codex-home`,
      FAKE_API_KEY: "fake-not-a-key",
    }),
  ).toMatch(/\nok\nrc=0$/);
  expect(
    await turn(
      "codex-error",
      "codex exec --skip-git-repo-check -c model_provider=broken 'Reply with ok.' < /dev/null",
      { CODEX_HOME: `${PROBE}/codex-home`, FAKE_API_KEY: "fake-not-a-key" },
    ),
  ).toMatch(/\nrc=1$/);

  // OpenCode through an OpenAI-compatible provider of its own.
  await write(
    containerId,
    `${PROBE}/opencode.json`,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        fake: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fake",
          options: { baseURL: openai, apiKey: "fake-not-a-key" },
          models: { "fake-model": { name: "Fake" } },
        },
      },
      model: "fake/fake-model",
    }),
  );
  expect(await turn("opencode", "opencode run -m fake/fake-model 'Reply with ok.'")).toMatch(
    /ok\s*\nrc=0$/,
  );

  // Pi through a `models.json` provider in the container's own home.
  await write(
    containerId,
    "/home/node/.pi/agent/models.json",
    JSON.stringify({
      providers: {
        fake: {
          name: "Fake",
          baseUrl: openai,
          api: "openai-completions",
          apiKey: "fake-not-a-key",
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: true,
            maxTokensField: "max_tokens",
          },
          models: [
            {
              id: "fake-model",
              name: "Fake",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 256,
            },
          ],
        },
      },
    }),
  );
  expect(await turn("pi", "pi -p --model fake/fake-model 'Reply with ok.'")).toMatch(/^ok\nrc=0$/);

  // Every turn reached the fake provider rather than finishing locally.
  await mark("end");
  const served = await counts();
  expect(served.anthropic ?? 0).toBeGreaterThanOrEqual(2);
  expect(served.responses ?? 0).toBeGreaterThanOrEqual(1);
  expect(served.chat ?? 0).toBeGreaterThanOrEqual(2);
  expect(served.broken ?? 0).toBeGreaterThanOrEqual(2);
  for (const elapsed of Object.values(results)) expect(elapsed).toBeLessThan(TURN_SECONDS * 1000);

  return { turnMs: results, served };
}
