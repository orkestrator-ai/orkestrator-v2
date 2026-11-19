import { describe, expect, test } from "bun:test";

import {
  MY_SETUP_ID,
  capabilityComponentId,
  type CapabilityComponent,
  type CapabilityPackage,
  type CapabilitySetup,
} from "./capability-resources.js";
import {
  canonicalCapabilityJson,
  capabilityInstallApproval,
  capabilityUpdateApproval,
  ceilingDenial,
  compareCapabilityRevisions,
  expandCapabilitySetup,
  resolveEffectiveAgentResources,
  UNRESTRICTED_CAPABILITY_CEILING,
  type CapabilityResolutionInput,
} from "./capability-resources-resolve.js";
import { describeCapabilitySupport } from "./capability-resources-support.js";

const hash = (text: string) =>
  `h:${text.length}:${[...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`;

function component(
  packageId: string,
  kind: CapabilityComponent["kind"],
  key: string,
  extra: Partial<CapabilityComponent> = {},
): CapabilityComponent {
  return {
    id: capabilityComponentId(packageId, kind, key),
    packageId,
    kind,
    pathOrKey: key,
    name: key,
    dependencies: [],
    providerHints: [],
    requirements: {},
    risk: "instructions",
    ...extra,
  };
}

function pkg(
  id: string,
  components: CapabilityComponent[],
  extra: Partial<CapabilityPackage> = {},
): CapabilityPackage {
  return {
    id,
    source: { kind: "managed", managedId: id },
    displayName: id,
    revision: "r1",
    artifactDigest: `sha256:${id}`,
    componentIds: components.map((entry) => entry.id),
    provenance: "managed",
    risk: "instructions",
    createdAt: "t",
    updatedAt: "t",
    ...extra,
  };
}

function setup(
  id: string,
  packageIds: string[],
  extra: Partial<CapabilitySetup> = {},
): CapabilitySetup {
  return {
    id,
    name: id,
    revision: 1,
    packageSelections: packageIds.map((packageId) => ({ packageId, version: "latest" })),
    providerSelectors: [],
    machineSelectors: [],
    exclusions: [],
    parentSetupIds: [],
    updatePolicy: "approve",
    updatedAt: "t",
    ...extra,
  };
}

function input(
  packages: CapabilityPackage[],
  components: CapabilityComponent[],
  setups: CapabilitySetup[],
  overrides: Partial<CapabilityResolutionInput> = {},
): CapabilityResolutionInput {
  return {
    facts: {
      target: { nodeId: "bk_1", provider: "claude" },
      groups: ["development"],
      enrolled: true,
    },
    layers: [{ scope: "my-setup", setupIds: [MY_SETUP_ID] }],
    setups: new Map(setups.map((entry) => [entry.id, entry])),
    packages: new Map(packages.map((entry) => [entry.id, entry])),
    components: new Map(components.map((entry) => [entry.id, entry])),
    support: describeCapabilitySupport("claude", { location: "host" }),
    ceiling: UNRESTRICTED_CAPABILITY_CEILING,
    hash,
    now: () => "now",
    ...overrides,
  };
}

const skill = component("p1", "skill", "review");
const docsServer = component("p1", "mcp-server", "docs", {
  risk: "network",
  endpoints: ["docs.example.com"],
});
const hook = component("p1", "hook", "PreToolUse", {
  risk: "privileged",
  executes: ["./guard.sh"],
  triggers: ["PreToolUse"],
});
const bundle = pkg("p1", [skill, docsServer, hook]);

describe("resolution", () => {
  test("My setup reaches an enrolled machine, not an unenrolled one", () => {
    const resolved = resolveEffectiveAgentResources(
      input([bundle], [skill, docsServer, hook], [setup(MY_SETUP_ID, ["p1"])]),
    );
    expect(resolved.resolvedPackages[0]!.components).toContain(skill.id);
    const off = resolveEffectiveAgentResources(
      input([bundle], [skill, docsServer, hook], [setup(MY_SETUP_ID, ["p1"])], {
        facts: { target: { nodeId: "bk_1", provider: "claude" }, groups: [], enrolled: false },
      }),
    );
    expect(off.resolvedPackages).toEqual([]);
  });

  test("components are judged one by one: the hook is unsupported, the rest delivered", () => {
    const resolved = resolveEffectiveAgentResources(
      input([bundle], [skill, docsServer, hook], [setup(MY_SETUP_ID, ["p1"])]),
    );
    expect(resolved.resolvedPackages[0]!.components.sort()).toEqual(
      [docsServer.id, skill.id].sort(),
    );
    expect(resolved.unsupported.map((entry) => entry.componentId)).toEqual([hook.id]);
  });

  test("deny wins: a toolkit cannot grant an MCP server or network the policy denies", () => {
    const resolved = resolveEffectiveAgentResources(
      input([bundle], [skill, docsServer, hook], [setup(MY_SETUP_ID, ["p1"])], {
        ceiling: { denied: ["mcp:docs"], userMcpServers: null, digest: "d1" },
      }),
    );
    expect(resolved.blocked.map((entry) => entry.componentId)).toEqual([docsServer.id]);
    const grantless = resolveEffectiveAgentResources(
      input([bundle], [skill, docsServer, hook], [setup(MY_SETUP_ID, ["p1"])], {
        ceiling: { denied: [], userMcpServers: ["other"], digest: "d2" },
      }),
    );
    expect(grantless.blocked[0]!.reason).toContain("grant");
    const offline = resolveEffectiveAgentResources(
      input([bundle], [skill, docsServer, hook], [setup(MY_SETUP_ID, ["p1"])], {
        ceiling: { denied: ["network"], userMcpServers: null, digest: "d3" },
      }),
    );
    expect(offline.blocked.map((entry) => entry.componentId)).toEqual([docsServer.id]);
    expect(offline.permissionPolicyDigest).toBe("d3");
  });

  test("a required component that cannot be delivered blocks the launch; an optional one warns", () => {
    const required = setup(MY_SETUP_ID, []);
    required.packageSelections = [{ packageId: "p1", version: "latest", required: true }];
    const blocked = resolveEffectiveAgentResources(
      input([bundle], [skill, docsServer, hook], [required], {
        ceiling: { denied: ["mcp:docs"], userMcpServers: null, digest: "d" },
      }),
    );
    expect(blocked.launchBlockers.map((entry) => entry.componentId).sort()).toEqual(
      [docsServer.id, hook.id].sort(),
    );
    const optional = resolveEffectiveAgentResources(
      input([bundle], [skill, docsServer, hook], [setup(MY_SETUP_ID, ["p1"])]),
    );
    expect(optional.launchBlockers).toEqual([]);
    expect(optional.warnings.some((warning) => warning.includes("skipped"))).toBe(true);
  });

  test("more specific layers override versions with a diagnostic, and exclusions apply per target", () => {
    const versioned = pkg("p1", [skill], {
      revision: "r2",
      artifactDigest: "sha256:new",
      previousRevisions: [
        {
          revision: "r1",
          artifactDigest: "sha256:old",
          replacedAt: "t",
          components: [skill, docsServer],
        },
      ],
    });
    const mine = setup(MY_SETUP_ID, []);
    mine.packageSelections = [{ packageId: "p1", version: "r2" }];
    const resolved = resolveEffectiveAgentResources(
      input([versioned], [skill], [mine], {
        layers: [
          { scope: "my-setup", setupIds: [MY_SETUP_ID] },
          { scope: "session", selections: [{ packageId: "p1", version: "r1" }] },
        ],
      }),
    );
    expect(resolved.resolvedPackages[0]!.artifactDigest).toBe("sha256:old");
    expect(resolved.resolvedPackages[0]!.components).toContain(docsServer.id);
    expect(resolved.warnings[0]).toContain("overrides version r2");

    const excluded = setup(MY_SETUP_ID, ["p1"], { exclusions: ["provider:claude|p1"] });
    expect(
      resolveEffectiveAgentResources(input([bundle], [skill, docsServer, hook], [excluded]))
        .resolvedPackages,
    ).toEqual([]);
    const otherProvider = setup(MY_SETUP_ID, ["p1"], { exclusions: ["provider:pi|p1"] });
    expect(
      resolveEffectiveAgentResources(input([bundle], [skill, docsServer, hook], [otherProvider]))
        .resolvedPackages,
    ).toHaveLength(1);
  });

  test("administrator policy forbids a source whatever a layer asks", () => {
    const resolved = resolveEffectiveAgentResources(
      input([bundle], [skill, docsServer, hook], [setup(MY_SETUP_ID, ["p1"])], {
        admin: { forbiddenSources: ["p1"] },
      }),
    );
    expect(resolved.resolvedPackages).toEqual([]);
    expect(resolved.blocked.length).toBeGreaterThan(0);
  });

  test("paused packages are not delivered", () => {
    const paused = pkg("p1", [skill], { paused: true });
    const resolved = resolveEffectiveAgentResources(
      input([paused], [skill], [setup(MY_SETUP_ID, ["p1"])]),
    );
    expect(resolved.resolvedPackages).toEqual([]);
  });

  test("the manifest digest is deterministic and changes with the policy", () => {
    const a = resolveEffectiveAgentResources(
      input([bundle], [skill, docsServer, hook], [setup(MY_SETUP_ID, ["p1"])]),
    );
    const b = resolveEffectiveAgentResources(
      input([bundle], [skill, docsServer, hook], [setup(MY_SETUP_ID, ["p1"])]),
    );
    expect(a.manifestDigest).toBe(b.manifestDigest);
    const c = resolveEffectiveAgentResources(
      input([bundle], [skill, docsServer, hook], [setup(MY_SETUP_ID, ["p1"])], {
        ceiling: { denied: ["shell"], userMcpServers: null, digest: "other" },
      }),
    );
    expect(c.manifestDigest).not.toBe(a.manifestDigest);
  });

  test("setup cycles are reported and never followed forever", () => {
    const a = setup("a", [], { parentSetupIds: ["b"] });
    const b = setup("b", [], { parentSetupIds: ["a"] });
    const { order, errors } = expandCapabilitySetup(
      "a",
      new Map([
        ["a", a],
        ["b", b],
      ]),
    );
    expect(order.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(errors[0]).toContain("cycle");
  });

  test("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalCapabilityJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe(
      '{"a":{"c":[2,1]},"b":1}',
    );
  });
});

describe("approvals", () => {
  test("hooks, MCP servers and scripts need approval; plain instructions do not", () => {
    expect(capabilityInstallApproval([skill]).requiresApproval).toBe(false);
    const result = capabilityInstallApproval([hook, docsServer]);
    expect(result.requiresApproval).toBe(true);
    expect(result.reasons[0]).toContain("./guard.sh");
    expect(result.reasons[0]).toContain("PreToolUse");
  });

  test("a trusted update applies on its own only when nothing escalates", () => {
    const before = [skill];
    const quiet = compareCapabilityRevisions(before, [{ ...skill, description: "better" }]);
    expect(capabilityUpdateApproval("trusted-auto", quiet, true)).toEqual({
      requiresApproval: false,
      autoApply: true,
      reasons: [],
    });
    const withHook = compareCapabilityRevisions(before, [skill, hook]);
    const decision = capabilityUpdateApproval("trusted-auto", withHook, true);
    expect(decision.autoApply).toBe(false);
    expect(decision.reasons[0]).toContain("hook");
    const newProgram = compareCapabilityRevisions(
      [docsServer],
      [{ ...docsServer, endpoints: ["evil.example.com"] }],
    );
    expect(newProgram[0]!.escalation).toContain("endpoint");
    expect(capabilityUpdateApproval("approve", quiet, true).requiresApproval).toBe(true);
    expect(capabilityUpdateApproval("pinned", quiet, true).autoApply).toBe(false);
    expect(capabilityUpdateApproval("trusted-auto", quiet, false).autoApply).toBe(false);
  });

  test("ceiling denial covers hooks and subagents", () => {
    expect(ceilingDenial(hook, new Set(["shell"]), null)).toContain("hook");
    expect(ceilingDenial(component("p", "subagent", "x"), new Set(["subagents"]), null)).toContain(
      "subagents",
    );
    expect(ceilingDenial(skill, new Set(["shell"]), null)).toBeUndefined();
  });
});

test("a Claude bundle cannot deliver an excluded or ceiling-denied component", () => {
  const id = "managed:bundle";
  const plugin = component(id, "native-plugin", ".claude-plugin/plugin.json", {
    providerHints: ["claude"],
  });
  const mcp = component(id, "mcp-server", "local", { dependencies: [plugin.id] });
  const packageEntry = pkg(id, [plugin, mcp]);
  const base = setup(MY_SETUP_ID, [id]);
  for (const resolved of [
    resolveEffectiveAgentResources(
      input([packageEntry], [plugin, mcp], [{ ...base, exclusions: [mcp.id] }]),
    ),
    resolveEffectiveAgentResources(
      input([packageEntry], [plugin, mcp], [base], {
        ceiling: { denied: ["mcp:local"], userMcpServers: null, digest: "denied" },
      }),
    ),
  ]) {
    expect(resolved.resolvedPackages).toEqual([]);
    expect(resolved.blocked.some((entry) => entry.componentId === plugin.id)).toBe(true);
  }
});

test("a trusted update needs approval when the hook's files change", () => {
  const hook = component("managed:hook", "hook", "guard", { executes: ["./guard.sh"] });
  const unchanged = compareCapabilityRevisions([hook], [hook], () => false);
  expect(unchanged).toEqual([]);
  const changed = compareCapabilityRevisions([hook], [hook], () => true);
  expect(capabilityUpdateApproval("trusted-auto", changed, true).requiresApproval).toBe(true);
});
