/**
 * The model connection a read-only turn keeps from the user's Claude settings
 * (to-do 7565).
 *
 * A read-only turn (Multi Review's reviewers and consolidation, plan-mode
 * fan-out reviewers, every coordinator turn) loads no settings file
 * (`claudeSettingSources` returns `[]`), because a settings file can carry
 * hooks, permission rules and plugins that would widen it. That also dropped
 * the `env` a user points Claude Code at its model with: an
 * `ANTHROPIC_BASE_URL` and token in `~/.claude/settings.json` reached every
 * ordinary turn, and every reviewer answered "Not logged in".
 *
 * The bridge therefore reads the user settings file itself and hands the turn
 * only the `env` entries that choose the model endpoint and its credential.
 * Nothing else is taken: no hook, permission rule, plugin, `apiKeyHelper` (a
 * command, which would run outside the read-only hook) or any other variable.
 * Project and local settings files are repository content and stay out. The
 * values are credentials: they are never logged, and only a digest of them
 * reaches the launch profile. A Bedrock connection that would make the CLI
 * resolve AWS profiles, which can run a `credential_process`, is not taken
 * either (`readOnlyConnectionOverlay`).
 *
 * The file read is the one the CLI would read, `$CLAUDE_CONFIG_DIR/settings.json`
 * else `~/.claude/settings.json`. A coordinator bridge runs with
 * `CLAUDE_CONFIG_DIR` at its private, empty Claude home
 * (`applyCoordinatorClaudeAccount` in `apps/backend`), so it finds no file and
 * takes nothing: a coordinator connects with the account token the backend
 * hands it, not with the user's settings. The reviewers and consolidation of
 * a Multi Review run on ordinary bridges and do get the connection.
 */
import { createLogger } from "@orkestrator/protocol/logger";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { claudeUserSettingsPath } from "./claude-home.js";
import { readJsonSliceCached } from "./json-file-cache.js";
import { isCoordinatorReadOnlyPolicy } from "./read-only-policy.js";

const log = createLogger("bridge.claude");

/**
 * Variables that choose the model endpoint, the credential sent to it, or the
 * model names behind Claude Code's aliases, as the pinned CLI reads them.
 * Kept to Claude Code's documented connection settings; anything that names a
 * program to run, a configuration file to load or the CLI's behaviour stays
 * out (`AWS_CONFIG_FILE`, `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES`,
 * `NODE_OPTIONS`, `CLAUDE_CODE_SHELL_PREFIX`, …). `AWS_PROFILE` is out too:
 * it selects a profile from `~/.aws/config`, and a profile (directly or
 * through `source_profile`) can name a `credential_process` that the AWS
 * credential chain runs outside the read-only hook. Recheck on a Claude bump.
 */
export const READ_ONLY_CONNECTION_ENV_NAMES: ReadonlySet<string> = new Set([
  // First-party API, a gateway or a proxy in front of it.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // Model names behind the aliases a gateway or cloud provider serves.
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  // Amazon Bedrock.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  // Google Vertex AI.
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLOUD_ML_REGION",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_APPLICATION_CREDENTIALS",
  // Microsoft Foundry.
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  // The route to the endpoint: proxy, TLS trust and client certificate.
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
]);

/** Families named by a pattern: an alias's model, and Vertex's per-model region. */
const READ_ONLY_CONNECTION_ENV_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_DEFAULT_[A-Z0-9]+_MODEL$/,
  /^VERTEX_REGION_CLAUDE_[A-Z0-9_]+$/,
];

/** Far more than any connection needs; a larger entry or set is not taken. */
const MAX_CONNECTION_ENV_ENTRIES = 64;
const MAX_CONNECTION_ENV_VALUE_BYTES = 16 * 1024;

export function isReadOnlyConnectionEnvName(name: string): boolean {
  return (
    READ_ONLY_CONNECTION_ENV_NAMES.has(name) ||
    READ_ONLY_CONNECTION_ENV_PATTERNS.some((pattern) => pattern.test(name))
  );
}

/**
 * The connection entries of a settings document's `env`, as the CLI would
 * apply them. Anything malformed names nothing: a non-object `env`, a value
 * that is not a string (the CLI coerces numbers and booleans, so those are
 * kept as their string form), an over-long value or a NUL.
 */
export function selectReadOnlyConnectionEnv(settings: unknown): Record<string, string> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const env = (settings as { env?: unknown }).env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  const selected: Record<string, string> = {};
  let count = 0;
  for (const [name, raw] of Object.entries(env)) {
    if (!isReadOnlyConnectionEnvName(name)) continue;
    const value =
      typeof raw === "string"
        ? raw
        : typeof raw === "number" || typeof raw === "boolean"
          ? String(raw)
          : undefined;
    if (value === undefined || value.includes("\0")) continue;
    if (Buffer.byteLength(value, "utf8") > MAX_CONNECTION_ENV_VALUE_BYTES) continue;
    if (++count > MAX_CONNECTION_ENV_ENTRIES) break;
    selected[name] = value;
  }
  return selected;
}

/** The user settings file's connection entries; empty when it is missing or malformed. */
export async function readUserSettingsConnectionEnv(
  settingsPath: string = claudeUserSettingsPath(),
): Promise<Readonly<Record<string, string>>> {
  // Only the selected entries are cached, never the rest of the document.
  const selected = await readJsonSliceCached<unknown, Record<string, string>>(
    settingsPath,
    "read-only-connection-env",
    selectReadOnlyConnectionEnv,
  );
  return selected ?? {};
}

/** The settings entries that turn Bedrock on or supply its credential. */
const BEDROCK_AUTH_ENV_NAMES: readonly string[] = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

const FALSE_FLAG_VALUES = new Set(["", "0", "false", "no", "off"]);
const TRUE_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);

/** Any value but an explicit "off" counts as on, so a doubtful flag is treated as Bedrock. */
function flagMayBeOn(value: string | undefined): boolean {
  return value !== undefined && !FALSE_FLAG_VALUES.has(value.trim().toLowerCase());
}

/** Only an explicit "on" counts, so a doubtful flag never skips authentication. */
function flagIsOn(value: string | undefined): boolean {
  return value !== undefined && TRUE_FLAG_VALUES.has(value.trim().toLowerCase());
}

/**
 * Whether the CLI would resolve Bedrock credentials through the AWS default
 * chain. With Bedrock on and none of a skip flag, a bearer token or a static
 * key pair, the pinned CLI asks that chain, which reads `~/.aws/config` and
 * `~/.aws/credentials` and runs a profile's `credential_process`: a command
 * outside the read-only hook and command sandbox.
 */
export function bedrockResolvesAwsProfiles(environment: NodeJS.ProcessEnv): boolean {
  if (!flagMayBeOn(environment.CLAUDE_CODE_USE_BEDROCK)) return false;
  if (flagIsOn(environment.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) return false;
  if (environment.AWS_BEARER_TOKEN_BEDROCK?.trim()) return false;
  return !(environment.AWS_ACCESS_KEY_ID?.trim() && environment.AWS_SECRET_ACCESS_KEY?.trim());
}

/**
 * The settings connection a read-only turn may take over `environment`. A
 * settings file that would send the turn to the AWS credential chain (Bedrock
 * on, no bearer token, static key pair or skip flag), where the bridge's own
 * environment did not, keeps its endpoint and model entries but loses its
 * Bedrock switch and credentials: the turn stays on the connection it would
 * have had without the file. A bridge whose own environment already uses the
 * chain is the user's launch choice and is not this module's to change.
 */
export function readOnlyConnectionOverlay(
  environment: NodeJS.ProcessEnv,
  connection: Readonly<Record<string, string>>,
): { overlay: Readonly<Record<string, string>>; withheldBedrock: boolean } {
  if (
    !bedrockResolvesAwsProfiles({ ...environment, ...connection }) ||
    bedrockResolvesAwsProfiles(environment)
  ) {
    return { overlay: connection, withheldBedrock: false };
  }
  const overlay = { ...connection };
  for (const name of BEDROCK_AUTH_ENV_NAMES) delete overlay[name];
  return { overlay, withheldBedrock: true };
}

/**
 * The environment of a turn that loads no settings file: `environment` plus
 * the user settings file's connection entries. They win over the bridge's own
 * values, as they do for an ordinary turn, where the CLI applies the file's
 * `env` over the environment it was started with. Managed settings still
 * apply on top, inside the CLI. Every other turn loads the user settings file
 * itself and gets `environment` unchanged.
 *
 * A Bedrock connection that would resolve through AWS profiles is withheld
 * (`readOnlyConnectionOverlay`) and a content-free warning says why: such a
 * review needs `AWS_BEARER_TOKEN_BEDROCK` or a static key pair in the
 * settings `env` instead.
 */
export async function withReadOnlyConnectionEnv(
  turnPolicy: NativeAgentExecutionPolicy | undefined,
  environment: NodeJS.ProcessEnv,
  readConnectionEnv: () => Promise<Readonly<Record<string, string>>> = () =>
    readUserSettingsConnectionEnv(),
): Promise<NodeJS.ProcessEnv> {
  if (!isCoordinatorReadOnlyPolicy(turnPolicy)) return environment;
  const connection = await readConnectionEnv();
  if (Object.keys(connection).length === 0) return environment;
  const { overlay, withheldBedrock } = readOnlyConnectionOverlay(environment, connection);
  if (withheldBedrock) {
    log.warn("read-only-connection.bedrock-withheld");
  }
  if (Object.keys(overlay).length === 0) return environment;
  return { ...environment, ...overlay };
}

/**
 * The connection variables of an environment, for the launch profile's
 * credential digest: a warm CLI started on one endpoint or credential must
 * not be joined by a turn whose settings name another.
 */
export function connectionEnvFingerprint(environment: NodeJS.ProcessEnv): [string, string][] {
  return Object.entries(environment)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && isReadOnlyConnectionEnvName(entry[0]),
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}
