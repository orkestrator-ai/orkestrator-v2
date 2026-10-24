import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  AgentSignInTerminal,
  HostAgentSignIn,
  HostAgentSignIns,
  HostSignInPlatform,
} from "@orkestrator/protocol/agent-accounts";

import type { CommandContext } from "./commands-context.js";
import type { Environment } from "./models.js";

/**
 * Grok's and Pi's sign-in state on this machine, read without a session.
 *
 * Neither platform has accounts: each keeps one login per machine, which every
 * local bridge inherits from the backend's own environment and home. This is
 * the evidence a local bridge would sign in with, read from files and
 * variable names only. Nothing is checked against the provider, and no value
 * is ever read into the answer. See docs/architecture/agent-accounts.md.
 */

/** A file this large is not a login. */
const MAX_LOGIN_FILE_BYTES = 1024 * 1024;

type ProcessEnvironment = Record<string, string | undefined>;

async function fileExists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    (info) => info.isFile(),
    () => false,
  );
}

async function readSmallFile(file: string): Promise<string | undefined> {
  try {
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > MAX_LOGIN_FILE_BYTES) return undefined;
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function present(env: ProcessEnvironment, name: string): boolean {
  return Boolean(env[name]?.trim());
}

/**
 * The same evidence the Grok bridge accepts before it lets Grok start
 * (`acpSignInMissing` in the ACP bridge): `XAI_API_KEY`, an auth-provider
 * command, or `$GROK_HOME/auth.json`.
 */
export async function readGrokSignIn(
  env: ProcessEnvironment = process.env,
): Promise<HostAgentSignIn> {
  if (present(env, "XAI_API_KEY")) return { state: "signed-in", source: "XAI_API_KEY" };
  if (present(env, "GROK_AUTH_PROVIDER_COMMAND")) {
    return { state: "signed-in", source: "Auth provider command" };
  }
  const home = env.GROK_HOME?.trim() || path.join(env.HOME?.trim() || homedir(), ".grok");
  if (await fileExists(path.join(home, "auth.json"))) {
    return { state: "signed-in", source: "Stored login" };
  }
  const config = (await readSmallFile(path.join(home, "config.toml"))) ?? "";
  if (/^\s*auth_provider_command\s*=/m.test(config)) {
    return { state: "signed-in", source: "Auth provider command" };
  }
  return { state: "signed-out" };
}

/**
 * Provider keys Pi reads from the environment, for the providers people sign
 * in to most (`getApiKeyEnvVars` in `@earendil-works/pi-ai`). A key for a
 * provider not listed reads as no login here, though Pi would use it.
 */
const PI_PROVIDER_KEY_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "CEREBRAS_API_KEY",
] as const;

const MAX_LISTED_PROVIDERS = 6;

/**
 * Pi's stored logins (`~/.pi/agent/auth.json`, one entry per provider), else a
 * provider key in the environment. Only provider ids are read from the file.
 * Local Pi bridges run with Pi's default directory, so `PI_AGENT_DIR` is not
 * consulted.
 */
export async function readPiSignIn(
  env: ProcessEnvironment = process.env,
  home = env.HOME?.trim() || homedir(),
): Promise<HostAgentSignIn> {
  const raw = await readSmallFile(path.join(home, ".pi", "agent", "auth.json"));
  let providers: string[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      providers = Object.entries(parsed as Record<string, unknown>)
        .filter(
          ([id, entry]) =>
            /^[\w.-]{1,64}$/.test(id) &&
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof (entry as { type?: unknown }).type === "string",
        )
        .map(([id]) => id)
        .sort();
    }
  } catch {
    providers = [];
  }
  if (providers.length > 0) {
    const listed = providers.slice(0, MAX_LISTED_PROVIDERS).join(", ");
    return {
      state: "signed-in",
      source: providers.length > MAX_LISTED_PROVIDERS ? `${listed}, …` : listed,
    };
  }
  const key = PI_PROVIDER_KEY_ENV.find((name) => present(env, name));
  if (key) return { state: "signed-in", source: key };
  return { state: "signed-out" };
}

export async function readHostAgentSignIns(
  env: ProcessEnvironment = process.env,
): Promise<HostAgentSignIns> {
  const [grok, pi] = await Promise.all([readGrokSignIn(env), readPiSignIn(env)]);
  return { grok, pi };
}

/**
 * The command a sign-in terminal runs. Fixed here, never taken from a request:
 * it is typed into a shell on this machine. Pi's login is its own interactive
 * `/login`, so the terminal opens Pi and the user runs it there.
 */
const SIGN_IN_COMMANDS: Record<HostSignInPlatform, string> = {
  grok: "grok login",
  pi: "pi",
};

/** The same readiness `launch_terminal_job` requires before it opens a terminal. */
function canHostSignInTerminal(environment: Environment): boolean {
  return (
    environment.environmentType === "local" &&
    environment.status === "running" &&
    !environment.deletionRequestedAt &&
    environment.lifecycleOperation !== "deleting" &&
    (environment.setupPhase === "ready" ||
      environment.setupScriptsComplete === true ||
      environment.setupOverride === true)
  );
}

function activityTime(environment: Environment): number {
  const time = Date.parse(environment.lastActivityAt ?? environment.createdAt);
  return Number.isFinite(time) ? time : 0;
}

/**
 * Open a terminal tab running the platform's login command on this machine.
 *
 * A terminal belongs to an environment, and a container's terminal would sign
 * in inside the container, so only a running local environment will do: the
 * one asked for when it qualifies, otherwise the most recently active one.
 */
export async function openAgentSignInTerminal(
  context: CommandContext,
  platform: HostSignInPlatform,
  options: {
    environmentId?: string;
    launchTerminalJob: (args: Record<string, unknown>) => Promise<{ tabId: string }>;
  },
): Promise<AgentSignInTerminal> {
  const candidates = (await context.storage.loadEnvironments()).filter(canHostSignInTerminal);
  const environment =
    candidates.find((candidate) => candidate.id === options.environmentId) ??
    candidates.sort((a, b) => activityTime(b) - activityTime(a))[0];
  if (!environment) {
    throw new Error(
      "Start a local environment on this machine first: the sign-in runs in one of its terminals.",
    );
  }
  const label = platform === "grok" ? "Grok" : "Pi";
  const { tabId } = await options.launchTerminalJob({
    environmentId: environment.id,
    requestId: `agent-sign-in-${platform}-${Date.now()}`,
    tabType: "plain",
    title: `${label} sign-in`,
    data: `${SIGN_IN_COMMANDS[platform]}\n`,
    activateTab: true,
  });
  return { environmentId: environment.id, projectId: environment.projectId, tabId };
}
