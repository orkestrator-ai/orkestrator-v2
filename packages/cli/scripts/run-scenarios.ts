import { readdir } from "node:fs/promises";
import path from "node:path";
import { SCENARIOS, type ScenarioDefinition } from "../scenarios/cases.js";
import {
  CliDriver,
  newScenarioRoot,
  PACKAGE_ROOT,
  removeTree,
  RunManifest,
  runId,
  ScenarioFailure,
  startIsolatedBackend,
  type ScenarioContext,
} from "../scenarios/harness.js";

/**
 * Run targeted CLI scenarios against isolated backends started through the
 * packaged launcher. Credential-free scenarios run by default; `--provider`
 * adds the live, credentialed scenario for that provider, and
 * `--environment-type container` runs the container variants against the
 * explicitly named `--docker-image` (never the shared `latest` tag). Pi,
 * Cursor and Grok run their worktree-built bridge beside the packaged ones
 * (see `scenarios/provider-runtime.ts`), so build it first.
 *
 *   bun scripts/run-scenarios.ts [--scenario NAME]... [--provider NAME]
 *     [--environment-type local|container] [--docker-image TAG]
 *     [--keep-on-failure]
 *
 * Requires `bun run build` first. The exit status is authoritative: 0 when
 * every selected scenario passed and cleaned up.
 */

export interface Options {
  scenarios: string[];
  provider?: string;
  environmentType: "local" | "container";
  dockerImage?: string;
  keepOnFailure: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    scenarios: [],
    environmentType: "local",
    keepOnFailure: false,
    list: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${token} requires a value`);
      index += 1;
      return next;
    };
    if (token === "--scenario") options.scenarios.push(value());
    else if (token === "--provider") options.provider = value();
    else if (token === "--environment-type") {
      const type = value();
      if (type !== "local" && type !== "container")
        throw new Error("--environment-type must be local or container");
      options.environmentType = type;
    } else if (token === "--docker-image") options.dockerImage = value();
    else if (token === "--keep-on-failure") options.keepOnFailure = true;
    else if (token === "--list") options.list = true;
    else throw new Error(`Unknown option ${token.split("=")[0]}`);
  }
  if (options.environmentType === "container") {
    if (!options.dockerImage)
      throw new Error(
        "--environment-type container requires --docker-image (a worktree-owned tag)",
      );
    if (options.dockerImage.endsWith(":latest"))
      throw new Error("Refusing the shared latest image; build one with mise run docker:build:dev");
  }
  return options;
}

function select(options: Options): ScenarioDefinition[] {
  const known = new Set(SCENARIOS.map((scenario) => scenario.name));
  for (const name of options.scenarios) {
    if (!known.has(name)) throw new Error(`Unknown scenario ${name}; run with --list`);
  }
  return SCENARIOS.filter((scenario) => {
    if (options.scenarios.length > 0 && !options.scenarios.includes(scenario.name)) return false;
    if (scenario.live && !options.provider) return false;
    if (scenario.environmentTypes && !scenario.environmentTypes.includes(options.environmentType))
      return false;
    return true;
  });
}

interface ScenarioDependencies {
  newScenarioRoot: typeof newScenarioRoot;
  startIsolatedBackend: typeof startIsolatedBackend;
  removeTree: typeof removeTree;
  now: () => number;
}

const defaultDependencies: ScenarioDependencies = {
  newScenarioRoot,
  startIsolatedBackend,
  removeTree,
  now: Date.now,
};

export async function runOne(
  definition: ScenarioDefinition,
  options: Options,
  manifest: RunManifest,
  dependencies: ScenarioDependencies = defaultDependencies,
): Promise<{
  name: string;
  passed: boolean;
  durationMs: number;
  /** Launch to the backend's readiness line; null when it never became ready. */
  backendReadyMs: number | null;
  error?: string;
  cleanupErrors: string[];
}> {
  const started = dependencies.now();
  let backendReadyMs: number | null = null;
  const root = await dependencies.newScenarioRoot(definition.name);
  const cleanupErrors: string[] = [];
  let passed = false;
  let error: string | undefined;
  let context: ScenarioContext | undefined;
  try {
    const backend = await dependencies.startIsolatedBackend({
      root,
      ...(options.provider && definition.live ? { credentialSource: options.provider } : {}),
      extraArgs: options.dockerImage ? ["--docker-image", options.dockerImage] : [],
    });
    backendReadyMs = dependencies.now() - started;
    context = {
      name: definition.name,
      root,
      backend,
      cli: new CliDriver(
        definition.name,
        {
          ORKESTRATOR_CLI_CONFIG_DIR: path.join(root, "cli-config"),
          ORKESTRATOR_DEV_ROOT: path.join(root, "dev-root"),
          ORKESTRATOR_SCENARIO_CWD: root,
        },
        manifest,
      ),
      manifest,
      cleanup: [],
      ...(options.provider ? { provider: options.provider } : {}),
      environmentType: options.environmentType,
      ...(options.dockerImage ? { dockerImage: options.dockerImage } : {}),
    };
    await definition.run(context);
    passed = true;
  } catch (caught) {
    error =
      caught instanceof ScenarioFailure || caught instanceof Error
        ? caught.message
        : String(caught);
  } finally {
    // Owned cleanup always runs; its failures are reported separately from
    // the scenario's own result.
    for (const step of context?.cleanup ?? []) {
      try {
        await step.run();
      } catch (caught) {
        cleanupErrors.push(
          `${step.label}: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    }
    if (context) {
      const code = await context.backend.stop();
      if (code !== 0) cleanupErrors.push(`backend exited ${code}`);
      if (options.environmentType === "local") {
        const leftovers = await readdir(context.backend.worktreeDir).catch(() => []);
        if (leftovers.length > 0)
          cleanupErrors.push(`worktrees left behind: ${leftovers.join(", ")}`);
      }
    }
    manifest.cleanupErrors.push(...cleanupErrors.map((entry) => `${definition.name}: ${entry}`));
    if (!(options.keepOnFailure && (!passed || cleanupErrors.length > 0)))
      await dependencies.removeTree(root);
    else console.error(`kept ${root} for inspection`);
  }
  return {
    name: definition.name,
    passed: passed && cleanupErrors.length === 0,
    durationMs: dependencies.now() - started,
    backendReadyMs,
    ...(error ? { error } : {}),
    cleanupErrors,
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const scenario of SCENARIOS) {
      console.log(
        `${scenario.name.padEnd(20)} ${scenario.live ? "[live] " : ""}${scenario.description}`,
      );
    }
    return 0;
  }
  const selected = select(options);
  if (selected.length === 0) throw new Error("No scenarios selected");
  const id = runId();
  const artifactDir = path.resolve(PACKAGE_ROOT, "../../output/cli-scenarios", id);
  const manifest = new RunManifest(path.join(artifactDir, "manifest.json"));
  return runScenarios(selected, options, manifest, id);
}

/** Execute the selected cases and persist the same readiness evidence we measured. */
export async function runScenarios(
  selected: ScenarioDefinition[],
  options: Options,
  manifest: RunManifest,
  id: string,
  dependencies: ScenarioDependencies = defaultDependencies,
): Promise<number> {
  const results = [];
  for (const definition of selected) {
    const result = await runOne(definition, options, manifest, dependencies);
    results.push(result);
    console.log(
      `${result.passed ? "PASS" : "FAIL"} ${result.name} (${(result.durationMs / 1000).toFixed(1)}s)${
        result.error ? `\n  ${result.error.split("\n").join("\n  ")}` : ""
      }${result.cleanupErrors.length ? `\n  cleanup: ${result.cleanupErrors.join("; ")}` : ""}`,
    );
  }
  await manifest.flush({
    run: id,
    provider: options.provider ?? null,
    environmentType: options.environmentType,
    results: results.map(({ name, passed, durationMs, backendReadyMs, cleanupErrors }) => ({
      name,
      passed,
      durationMs,
      backendReadyMs,
      cleanupErrors,
    })),
  });
  console.log(`manifest: ${manifest.file}`);
  return results.every((result) => result.passed) ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  });
}
