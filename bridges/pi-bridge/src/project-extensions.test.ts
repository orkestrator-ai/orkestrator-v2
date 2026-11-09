import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  BRIDGE_EXECUTION_POLICY_ENV,
  createPiSessionServices,
  newSessionState,
  piResourceLoaderPolicy,
  projectResourceDiscoveryOptions,
} from "./agent-session.js";
import {
  PROJECT_EXTENSIONS_REFUSED_NOTE,
  projectExtensionsRefusedForApprovals,
} from "./project-extensions.js";
import { piReportedPolicy } from "./public.js";

/**
 * A repository's Pi extensions never run inside an `ask` session's bridge
 * process, against the real pinned SDK, while its skills and prompt templates
 * still load and the bridge's own inline extensions (the approval gate among
 * them) keep working.
 */
const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

const globals = globalThis as { __orkProjectExtensionsRan?: string[] };
let previousPolicy: string | undefined;
let previousHome: string | undefined;
beforeEach(() => {
  previousPolicy = process.env[BRIDGE_EXECUTION_POLICY_ENV];
  delete process.env[BRIDGE_EXECUTION_POLICY_ENV];
  // Pi finds `~/.agents/skills` through HOME; never the developer's own.
  previousHome = process.env.HOME;
});
afterEach(() => {
  delete globals.__orkProjectExtensionsRan;
  if (previousPolicy === undefined) delete process.env[BRIDGE_EXECUTION_POLICY_ENV];
  else process.env[BRIDGE_EXECUTION_POLICY_ENV] = previousPolicy;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** Records that its module body ran, which is all a planted extension needs. */
const plantedExtension = (name: string) => `
globalThis.__orkProjectExtensionsRan = [...(globalThis.__orkProjectExtensionsRan ?? []), ${JSON.stringify(name)}];
export default function (pi) {
  pi.registerCommand(${JSON.stringify(name)}, { description: "planted", handler: async () => {} });
}
`;

async function fixture(): Promise<{ cwd: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "ork-pi-project-extensions-"));
  directories.push(root);
  const cwd = join(root, "checkout");
  const agentDir = join(root, "agent");
  process.env.HOME = join(root, "home");
  await write(join(agentDir, "settings.json"), "{}");
  // Discovered by convention, and named by the project's own settings.
  await write(join(cwd, ".pi/extensions/discovered.js"), plantedExtension("discovered"));
  await write(join(cwd, "tools/named.js"), plantedExtension("named"));
  await write(
    join(cwd, ".pi/settings.json"),
    JSON.stringify({ extensions: ["../tools/named.js"] }),
  );
  await write(
    join(cwd, ".pi/skills/release/SKILL.md"),
    "---\nname: release\ndescription: release skill\n---\nSteps.\n",
  );
  await write(join(cwd, ".pi/prompts/triage.md"), "---\ndescription: triage\n---\nTriage this.\n");
  return { cwd, agentDir };
}

const container = (approvals: NativeAgentExecutionPolicy["approvals"]) =>
  ({
    id: "interactive-container",
    sandbox: "container",
    approvals,
    projectResources: true,
    networkAccess: "restricted",
  }) satisfies NativeAgentExecutionPolicy;

async function load(policy: NativeAgentExecutionPolicy, readOnly = false) {
  const { cwd, agentDir } = await fixture();
  const state = newSessionState(undefined, policy);
  state.readOnly = readOnly;
  const services = await createPiSessionServices(state, {
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, {
      projectTrusted: piResourceLoaderPolicy(state, cwd).projectTrusted,
    }),
  });
  const loader = services.resourceLoader;
  return {
    state,
    errors: loader.getExtensions().errors,
    extensions: loader.getExtensions().extensions.map((extension) => extension.path),
    commands: loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.commands.keys()])
      .toSorted(),
    skills: loader.getSkills().skills.map((skill) => skill.name),
    prompts: loader.getPrompts().prompts.map((prompt) => prompt.name),
  };
}

const INLINE = [
  "<inline:orkestrator>",
  "<inline:orkestrator-mcp>",
  "<inline:orkestrator-command-changes>",
];

describe("Pi project extensions and the approval gate", () => {
  test("every writable policy with project resources reports the refusal", () => {
    for (const approvals of ["auto-approve", "ask", "deny"] as const) {
      for (const projectResources of [true, false]) {
        for (const readOnly of [false, true]) {
          expect(
            projectExtensionsRefusedForApprovals({ approvals, projectResources }, readOnly),
          ).toBe(projectResources && !readOnly);
        }
      }
    }
    expect(projectExtensionsRefusedForApprovals(undefined)).toBe(false);
  });

  test("discovery drops extensions under every policy", () => {
    expect(projectResourceDiscoveryOptions(true, false, "ask")).toEqual({
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: false,
      noContextFiles: false,
    });
    for (const approvals of ["auto-approve", "deny", undefined] as const) {
      expect(projectResourceDiscoveryOptions(true, false, approvals).noExtensions).toBe(true);
    }
    // Off and read-only stay as they were: nothing from the project loads.
    expect(projectResourceDiscoveryOptions(false, false, "ask").noSkills).toBe(true);
    expect(projectResourceDiscoveryOptions(true, true, "ask").noSkills).toBe(true);
  });

  test("an ask session never runs a planted extension, and keeps skills, templates and its own gate", async () => {
    const loaded = await load(container("ask"));
    expect(loaded.errors).toEqual([]);
    // Neither the discovered nor the settings-named extension's code ran.
    expect(globals.__orkProjectExtensionsRan).toBeUndefined();
    expect(loaded.extensions).toEqual(INLINE);
    expect(loaded.commands).toEqual([]);
    expect(loaded.skills).toEqual(["release"]);
    expect(loaded.prompts).toEqual(["triage"]);
  });

  for (const approvals of ["auto-approve", "deny"] as const) {
    test(`a ${approvals} session also excludes project extensions`, async () => {
      const loaded = await load(container(approvals));
      expect(loaded.errors).toEqual([]);
      // No policy may introduce executable resources into the shared bridge.
      expect(globals.__orkProjectExtensionsRan).toBeUndefined();
      expect(loaded.extensions).toEqual(expect.arrayContaining(INLINE));
      expect(loaded.commands).toEqual([]);
      expect(loaded.skills).toEqual(["release"]);
    });
  }

  test("configured npm and git packages never install on either reload or under any policy", async () => {
    const probe = new DefaultResourceLoader({ ...(await fixture()) }) as unknown as {
      packageManager: { installParsedSource: (...args: unknown[]) => Promise<void> };
    };
    const prototype = Object.getPrototypeOf(probe.packageManager);
    const original = prototype.installParsedSource;
    let installs = 0;
    prototype.installParsedSource = async () => {
      installs++;
      throw new Error("unexpected install");
    };
    try {
      for (const approvals of ["ask", "auto-approve", "deny"] as const) {
        const { cwd, agentDir } = await fixture();
        const packages = [
          "npm:@orkestrator-test/never-installed@1.0.0",
          "https://github.com/orkestrator-test/never-installed",
        ];
        await write(join(cwd, ".pi/settings.json"), JSON.stringify({ packages }));
        await write(join(agentDir, "settings.json"), JSON.stringify({ packages }));
        const state = newSessionState(undefined, container(approvals));
        const services = await createPiSessionServices(state, { cwd, agentDir });
        await services.resourceLoader.reload();
        expect(services.settingsManager.getProjectSettings().packages).toEqual([]);
        expect(services.settingsManager.getGlobalSettings().packages).toEqual([]);
        expect(services.resourceLoader.getSkills().skills.map((s) => s.name)).toEqual(["release"]);
      }
      expect(installs).toBe(0);
    } finally {
      prototype.installParsedSource = original;
    }
  });

  test("the reported policy says why an ask session's extensions did not load", () => {
    expect(piReportedPolicy(container("ask"), false).note).toContain(
      PROJECT_EXTENSIONS_REFUSED_NOTE,
    );
    // The axis stays on: skills and prompt templates still load.
    expect(piReportedPolicy(container("ask"), false).projectResources).toBe(true);
    expect(piReportedPolicy(container("auto-approve"), false).note ?? "").toContain(
      PROJECT_EXTENSIONS_REFUSED_NOTE,
    );
    // A read-only session loads no project resources at all, so there is nothing to explain.
    expect(piReportedPolicy(container("ask"), true).note ?? "").not.toContain(
      PROJECT_EXTENSIONS_REFUSED_NOTE,
    );
    expect(
      piReportedPolicy({ ...container("ask"), projectResources: false }, false).note ?? "",
    ).not.toContain(PROJECT_EXTENSIONS_REFUSED_NOTE);
    // Kept alongside the note a sandbox change adds.
    const host = piReportedPolicy(
      { ...container("ask"), id: "interactive-host", sandbox: "provider", networkAccess: "full" },
      false,
    );
    expect(host.note).toContain("Pi has no sandbox of its own");
    expect(host.note).toContain(PROJECT_EXTENSIONS_REFUSED_NOTE);
  });
});
