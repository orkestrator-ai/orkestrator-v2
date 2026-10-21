import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

// Real provider turns are opt-in. Credentials and model replies never enter traces.
test.use({ trace: "off", screenshot: "off" });
test.skip(
  process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1" ||
    process.env.ORKESTRATOR_AGENT_TEST_LIVE_GROK_LOGIN !== "1",
  "requires a Docker fixture profile authorized for Grok and the live-login opt-in",
);

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

function profileCommand(command: string) {
  const result = spawnSync("mise", ["run", command, "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`${command} failed`);
  return JSON.parse(result.stdout);
}

test("Docker fixture Grok login renewal reaches a reused bridge and conversation", async ({
  page,
}) => {
  test.setTimeout(360_000);
  const status = profileCommand("dev:status") as {
    status: string;
    dataDir: string;
    browserUrl: string;
    testProject: string;
  };
  expect(status.status).toBe("ready");
  const hostAuth = path.join(status.dataDir, "agent-credentials", "home", ".grok", "auth.json");
  const original = await fs.readFile(hostAuth, "utf8").catch(() => undefined);
  const usable =
    original &&
    Object.values(JSON.parse(original)).some((entry: unknown) => {
      const login = entry as { expires_at?: string };
      return (
        typeof login?.expires_at === "string" && Date.parse(login.expires_at) > Date.now() + 120_000
      );
    });
  test.skip(
    !usable,
    "the isolated host Grok login is absent or expired; renew it on the host and restart the profile",
  );

  const login = profileCommand("dev:login") as { loginUrl: string };
  await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      {
        data: { command, args },
      },
    );
    expect(response.ok(), `${command} failed`).toBe(true);
    return (await response.json()).result;
  };
  const projects = await invoke<Array<{ id: string; localPath: string }>>("get_projects");
  const project = projects.find((entry) => entry.localPath === status.testProject);
  expect(project).toBeTruthy();
  const environments = await invoke<Array<{ id: string; name: string; containerId?: string }>>(
    "get_environments",
    { projectId: project!.id },
  );
  const environment = environments.find((entry) => entry.name === "fixture-container");
  expect(environment?.containerId).toBeTruthy();
  const containerId = environment!.containerId!;
  const start = () =>
    invoke<{ hostPort: number; authToken: string; wasRunning: boolean }>("start_grok_server", {
      containerId,
    });
  const first = await start();
  const bridge = async <T>(route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${first.hostPort}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${first.authToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(90_000),
    });
    expect(response.ok, `Grok bridge ${route.split("/").at(-1)} failed`).toBe(true);
    return response.json() as Promise<T>;
  };
  const docker = (script: string) => {
    const result = spawnSync(
      "docker",
      ["exec", containerId, "bash", "-euc", `umask 077\n${script}`],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status, "container login assertion failed").toBe(0);
  };
  let sessionId: string | undefined;
  try {
    docker(
      'jq -e \'all(.[]; .refresh_token == "" or .refresh_token == null)\' "$HOME/.grok/auth.json" >/dev/null',
    );
    sessionId = (await bridge<{ id: string }>("/session/create", { readOnly: true })).id;
    const prompt = async (requestId: string, text: string, expected: string) => {
      await bridge(`/session/${sessionId}/prompt`, { prompt: text, requestId });
      await expect
        .poll(
          async () => {
            const current = await bridge<{ status: string; error?: string }>(
              `/session/${sessionId}/status`,
            );
            if (current.status === "error" || current.error)
              throw new Error("Grok provider turn failed");
            return current.status;
          },
          { timeout: 120_000 },
        )
        .toBe("idle");
      const current = await bridge<{ messages: Array<{ role: string; content: string }> }>(
        `/session/${sessionId}`,
      );
      expect(
        current.messages.some(
          (message) => message.role === "assistant" && message.content.includes(expected),
        ),
        "authenticated Grok reply missing",
      ).toBe(true);
    };
    const codeword = `ORK${Date.now()}`;
    await prompt("login-initial", `Remember ${codeword}. Reply only OK. Do not use tools.`, "OK");
    // Move the local expiry metadata past its boundary without waiting hours or
    // spending a refresh token. Only this disposable profile's host copy changes.
    const expired = JSON.parse(original!);
    for (const entry of Object.values(expired))
      (entry as { expires_at: string }).expires_at = "2000-01-01T00:00:00Z";
    await fs.writeFile(hostAuth, JSON.stringify(expired), { mode: 0o600 });
    docker(
      'jq \'with_entries(.value.expires_at = "2000-01-01T00:00:00Z")\' "$HOME/.grok/auth.json" > /tmp/grok-expired.json; cat /tmp/grok-expired.json > "$HOME/.grok/auth.json"; rm /tmp/grok-expired.json',
    );
    await start();
    docker(
      'jq -e \'all(.[]; .expires_at == "2000-01-01T00:00:00Z" and (.refresh_token == "" or .refresh_token == null))\' "$HOME/.grok/auth.json" >/dev/null',
    );
    // Replaying a current host snapshot models the host's independent renewal.
    await fs.writeFile(hostAuth, original!, { mode: 0o600 });
    const renewed = await start();
    expect(renewed.wasRunning).toBe(true);
    expect(
      renewed.hostPort === first.hostPort && renewed.authToken === first.authToken,
      "bridge was replaced",
    ).toBe(true);
    docker(
      'jq -e \'all(.[]; .expires_at != "2000-01-01T00:00:00Z" and (.refresh_token == "" or .refresh_token == null))\' "$HOME/.grok/auth.json" >/dev/null',
    );
    await prompt(
      "login-renewed",
      "What codeword did I ask you to remember? Reply with only that codeword. Do not use tools.",
      codeword,
    );
    expect((await fs.readFile(hostAuth, "utf8")) === original, "host login changed").toBe(true);
  } finally {
    await fs.writeFile(hostAuth, original!, { mode: 0o600 });
    if (sessionId) await bridge(`/session/${sessionId}/close`, {});
  }
});
