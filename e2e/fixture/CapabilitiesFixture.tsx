import { useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CapabilityAvailabilityCell,
  CapabilityComponent,
  CapabilityMachineSummary,
  CapabilityOperationSnapshot,
  CapabilityPackageDetail,
  CapabilityPackageSummary,
  CapabilityPlannedTarget,
  CapabilitySetup,
  CapabilityUpdateProposal,
  EffectiveAgentResources,
} from "@orkestrator/protocol/capability-resources";
import type {
  CapabilityImportPreview,
  CapabilitySessionView,
  CapabilitySourceInspection,
} from "@orkestrator/protocol/capability-resources-api";
import { GraphNodeToolkitsEditor } from "../../apps/web/src/components/graph-designer/GraphNodeToolkitsEditor";
import { FormSection } from "../../apps/web/src/components/graph-designer/graph-form-controls";
import { AgentInfoCapabilitiesSection } from "../../apps/web/src/components/layout/AgentInfoCapabilitiesSection";
import { FullscreenSettingsLayout } from "../../apps/web/src/components/settings/FullscreenSettingsLayout";
import { CapabilitiesSettings } from "../../apps/web/src/components/settings/capabilities/CapabilitiesSettings";
import { CapabilityScopeCard } from "../../apps/web/src/components/settings/capabilities/CapabilityScopeCard";

/**
 * Agent Capabilities against an in-memory `capabilities` domain
 * (docs/architecture/agent-capabilities-management.md). The real components
 * call `window.orkestrator.invoke` with the domain's command names; this
 * backend answers them from one state object and records each call in
 * `window.capabilityFixtureCalls`, so a spec asserts what crossed the
 * boundary.
 *
 * `?surface=settings` (default) is Settings → Capabilities inside the real
 * fullscreen settings layer; `?surface=session` the capability section of the
 * agent information panel, at the panel's width; `?surface=scopes` the
 * project and environment cards and a graph agent node's Toolkits section.
 * `?offline` makes the build box offline everywhere (stale data);
 * `window.capabilityFixtureFailNext(command, message)` fails the next call.
 */

declare global {
  interface Window {
    capabilityFixtureCalls?: Array<{ command: string; args: Record<string, unknown> }>;
    capabilityFixtureFailNext?: (command: string, message: string) => void;
  }
}

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "settings";
const offline = params.has("offline");
const NOW = "2026-11-19T09:00:00.000Z";
const DIGEST = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

const machines: CapabilityMachineSummary[] = [
  {
    nodeId: "bk_desk",
    name: "Desk",
    enrolled: true,
    groups: ["development"],
    connection: "self",
    appliedManifestDigest: DIGEST("1"),
    desiredManifestDigest: DIGEST("1"),
    pendingOperationIds: [],
    os: "linux",
    providers: [
      { provider: "claude", available: true },
      { provider: "codex", available: true },
    ],
    counts: { ready: 3, "installed-next-session": 1 },
  },
  {
    nodeId: "bk_laptop",
    name: "Laptop",
    enrolled: true,
    groups: ["laptops"],
    connection: "connected",
    appliedManifestDigest: DIGEST("2"),
    desiredManifestDigest: DIGEST("1"),
    pendingOperationIds: ["op-add"],
    os: "darwin",
    providers: [
      { provider: "claude", available: true },
      { provider: "codex", available: true },
    ],
    counts: { ready: 1, failed: 1, "needs-auth": 1 },
  },
  {
    nodeId: "bk_build",
    name: "Build box",
    enrolled: true,
    groups: [],
    connection: offline ? "offline" : "connected",
    lastSeenAt: "2026-11-18T22:00:00.000Z",
    appliedManifestDigest: DIGEST("3"),
    desiredManifestDigest: DIGEST("1"),
    pendingOperationIds: [],
    os: "linux",
    providers: [{ provider: "claude", available: true }],
    counts: { offline: 2 },
  },
];

const setups: CapabilitySetup[] = [
  {
    id: "my-setup",
    name: "My setup",
    builtIn: true,
    revision: 4,
    packageSelections: [
      { packageId: "managed:review", version: "latest" },
      { packageId: "git:org/agent-tools#docs-search", version: "latest" },
    ],
    providerSelectors: [],
    machineSelectors: ["*"],
    exclusions: [],
    parentSetupIds: [],
    updatePolicy: "approve",
    updatedAt: NOW,
  },
  {
    id: "frontend",
    name: "Frontend",
    revision: 2,
    packageSelections: [{ packageId: "managed:review", version: "latest" }],
    providerSelectors: [],
    machineSelectors: [],
    targetSelectors: [],
    exclusions: ["machine:bk_laptop|managed:review"],
    parentSetupIds: [],
    updatePolicy: "approve",
    updatedAt: NOW,
  },
  {
    id: "research",
    name: "Research",
    revision: 1,
    packageSelections: [],
    providerSelectors: [],
    machineSelectors: [],
    targetSelectors: [],
    exclusions: [],
    parentSetupIds: [],
    updatePolicy: "approve",
    updatedAt: NOW,
  },
];

function summary(
  overrides: Partial<CapabilityPackageSummary> & Pick<CapabilityPackageSummary, "id">,
): CapabilityPackageSummary {
  return {
    displayName: overrides.id,
    source: { kind: "managed", managedId: overrides.id },
    sourceLabel: "Authored in Orkestrator",
    revision: "a1b2c3d4e5f6a7b8",
    artifactDigest: DIGEST("a"),
    provenance: "managed",
    risk: "instructions",
    kinds: ["skill"],
    componentCount: 1,
    components: [],
    assignedSetupIds: ["my-setup"],
    readiness: "ready",
    attention: 0,
    updateAvailable: false,
    pinned: false,
    paused: false,
    updatedAt: NOW,
    ...overrides,
  };
}

const packages: CapabilityPackageSummary[] = [
  summary({
    id: "managed:review",
    displayName: "review",
    description: "Reviews a change before it is merged.",
    assignedSetupIds: ["my-setup", "frontend"],
    readiness: "ready",
    updateAvailable: true,
    components: [
      { id: "managed:review#skill:", kind: "skill", name: "review", risk: "instructions" },
    ],
  }),
  summary({
    id: "git:org/agent-tools#docs-search",
    displayName: "docs-search",
    description: "Searches the team's documentation over MCP.",
    source: { kind: "git", repo: "https://github.com/org/agent-tools", subpath: "docs-search" },
    sourceLabel: "github.com/org/agent-tools",
    revision: "9f8e7d6c5b4a3210",
    artifactDigest: DIGEST("b"),
    provenance: "external",
    risk: "network",
    kinds: ["mcp-server", "command"],
    componentCount: 2,
    readiness: "needs-attention",
    attention: 2,
  }),
  summary({
    id: "managed:release-notes",
    displayName: "release-notes",
    kinds: ["prompt"],
    assignedSetupIds: [],
    readiness: "unassigned",
  }),
];

const docsComponents: CapabilityComponent[] = [
  {
    id: "git:org/agent-tools#docs-search#mcp-server:docs",
    packageId: "git:org/agent-tools#docs-search",
    kind: "mcp-server",
    pathOrKey: "docs",
    name: "docs",
    dependencies: [],
    providerHints: [],
    requirements: { binaries: ["npx"], envRefs: ["DOCS_TOKEN"] },
    risk: "network",
    executes: ["npx @org/docs-mcp"],
    endpoints: ["docs.example.com"],
  },
  {
    id: "git:org/agent-tools#docs-search#command:search-docs",
    packageId: "git:org/agent-tools#docs-search",
    kind: "command",
    pathOrKey: "commands/search-docs.md",
    name: "search-docs",
    dependencies: [],
    providerHints: [],
    requirements: {},
    risk: "instructions",
  },
];

function cell(
  nodeId: string,
  provider: AgentPlatform,
  componentId: string,
  status: CapabilityAvailabilityCell["status"],
  extra: Partial<CapabilityAvailabilityCell> = {},
): CapabilityAvailabilityCell {
  return {
    target: { nodeId, provider },
    componentId,
    status,
    verification:
      status === "ready" ? "advertised" : status === "offline" ? "requested" : "present",
    ...extra,
  };
}

const MCP = docsComponents[0]!.id;
const CMD = docsComponents[1]!.id;

function packageDetail(id: string): CapabilityPackageDetail {
  const pkg = packages.find((entry) => entry.id === id)!;
  if (id === "git:org/agent-tools#docs-search") {
    return {
      package: pkg,
      components: docsComponents,
      availability: [
        cell("bk_desk", "claude", MCP, "ready", { lastVerifiedAt: NOW }),
        cell("bk_desk", "claude", CMD, "ready"),
        cell("bk_desk", "codex", MCP, "installed-next-session", {
          remedy: "Start a new Codex session to load it.",
        }),
        cell("bk_laptop", "claude", MCP, "failed", {
          reason: "npx is not on this machine's PATH.",
          remedy: "Install Node.js on Laptop, then apply again.",
        }),
        cell("bk_laptop", "codex", MCP, "needs-auth", {
          reason: "DOCS_TOKEN is not set on Laptop.",
          remedy: "Add DOCS_TOKEN in MCP servers settings on Laptop.",
        }),
        cell("bk_laptop", "cursor", CMD, "unsupported", {
          reason: "Cursor Agent has no custom commands.",
        }),
        cell("bk_build", "claude", MCP, "offline", {
          reason: "Waiting for the machine to connect.",
        }),
      ],
      previousRevisions: [],
      files: [
        { path: "mcp.json", bytes: 214, executable: false },
        { path: "commands/search-docs.md", bytes: 512, executable: false },
      ],
    };
  }
  return {
    package: pkg,
    components: [
      {
        id: `${id}#skill:`,
        packageId: id,
        kind: "skill",
        pathOrKey: "",
        name: pkg.displayName,
        dependencies: [],
        providerHints: [],
        requirements: {},
        risk: "instructions",
      },
    ],
    availability:
      pkg.assignedSetupIds.length === 0
        ? []
        : [
            cell("bk_desk", "claude", `${id}#skill:`, "ready"),
            cell("bk_desk", "codex", `${id}#skill:`, "ready", { alsoVisibleTo: ["cursor", "pi"] }),
            cell("bk_laptop", "claude", `${id}#skill:`, "ready"),
            cell(
              "bk_build",
              "claude",
              `${id}#skill:`,
              offline ? "offline" : "ready",
              offline ? { reason: "Waiting for the machine to connect." } : {},
            ),
          ],
    previousRevisions:
      id === "managed:review"
        ? [{ revision: "0011223344556677", artifactDigest: DIGEST("9"), replacedAt: NOW }]
        : [],
    files: [{ path: "SKILL.md", bytes: 340, executable: false }],
  };
}

function target(
  key: string,
  nodeId: string,
  provider: AgentPlatform,
  componentId: string,
  action: CapabilityPlannedTarget["action"],
  status: CapabilityPlannedTarget["status"],
  extra: Partial<CapabilityPlannedTarget> = {},
): CapabilityPlannedTarget {
  return {
    key,
    target: { nodeId, provider },
    componentId,
    packageId: componentId.split("#")[0]!,
    action,
    status,
    ...(action === "install" || action === "update" ? { toDigest: DIGEST("c") } : {}),
    ...extra,
  };
}

function operation(
  id: string,
  kind: CapabilityOperationSnapshot["kind"],
  targets: CapabilityPlannedTarget[],
  approvalReasons: string[] = [],
): CapabilityOperationSnapshot {
  const byStatus: Record<string, number> = {};
  for (const entry of targets) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  return {
    id,
    kind,
    state: "planned",
    planDigest: DIGEST(id.length.toString(16)),
    packageIds: [...new Set(targets.map((entry) => entry.packageId))],
    targets,
    requiresApproval: approvalReasons.length > 0,
    approvalReasons,
    summary: { total: targets.length, byStatus },
    correlationId: `corr-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const FRONTEND_SKILL = "managed:frontend-review#skill:";

function addPlan(args: Record<string, unknown>): CapabilityOperationSnapshot {
  const change = args.change as { excludedProviders?: string[]; excludedMachines?: string[] };
  const excludedMachines = new Set(change.excludedMachines ?? []);
  const excludedProviders = new Set(change.excludedProviders ?? []);
  const targets: CapabilityPlannedTarget[] = [];
  for (const machine of machines) {
    for (const provider of ["claude", "codex"] as const) {
      const key = `${machine.nodeId}|${provider}`;
      if (excludedMachines.has(machine.nodeId) || excludedProviders.has(provider)) {
        targets.push(
          target(key, machine.nodeId, provider, FRONTEND_SKILL, "skip", "unsupported", {
            reason: `Exception: not for ${machine.name} · ${provider === "claude" ? "Claude Code" : "Codex"}.`,
          }),
        );
        continue;
      }
      if (machine.connection === "offline") {
        targets.push(
          target(key, machine.nodeId, provider, FRONTEND_SKILL, "install", "offline", {
            reason: "Waiting for the machine to connect.",
            liveSemantics: "new-session-required",
          }),
        );
        continue;
      }
      targets.push(
        target(key, machine.nodeId, provider, FRONTEND_SKILL, "install", "pending", {
          liveSemantics: "available-next-turn",
          ...(provider === "codex" ? { alsoVisibleTo: ["cursor", "opencode"] } : {}),
        }),
      );
    }
  }
  targets.push(
    target("bk_desk|cursor", "bk_desk", "cursor", FRONTEND_SKILL, "skip", "unsupported", {
      reason: "Cursor Agent is not installed on Desk.",
    }),
  );
  return operation("op-add", "add-to-setup", targets);
}

const inspection: CapabilitySourceInspection = {
  inspectionId: "insp-1",
  expiresAt: "2026-11-19T10:00:00.000Z",
  source: { kind: "git", repo: "https://github.com/org/agent-tools", subpath: "frontend-review" },
  packageId: "managed:frontend-review",
  displayName: "frontend-review",
  description: "Checks frontend changes for accessibility regressions.",
  revision: "c0ffee00c0ffee00",
  artifactDigest: DIGEST("c"),
  risk: "instructions",
  components: [
    {
      id: FRONTEND_SKILL,
      packageId: "managed:frontend-review",
      kind: "skill",
      pathOrKey: "",
      name: "frontend-review",
      dependencies: [],
      providerHints: [],
      requirements: {},
      risk: "instructions",
    },
  ],
  files: [{ path: "SKILL.md", bytes: 1200, executable: false }],
  totalBytes: 1200,
  compatibleProviders: ["claude", "codex", "cursor", "opencode", "pi"],
  unsupported: [
    { provider: "grok", componentId: FRONTEND_SKILL, reason: "Grok Build has no skills." },
  ],
  approvalReasons: [],
  warnings: [],
  secretsFound: [],
};

const updates: CapabilityUpdateProposal[] = [
  {
    id: "update-review",
    packageId: "managed:review",
    fromRevision: "a1b2c3d4e5f6a7b8",
    toRevision: "b2c3d4e5f6a7b8c9",
    fromDigest: DIGEST("a"),
    toDigest: DIGEST("d"),
    detectedAt: NOW,
    state: "pending",
    requiresApproval: true,
    reasons: ["The new revision adds a hook that runs a program."],
    changes: [
      { componentId: "managed:review#skill:", kind: "skill", change: "modified" },
      {
        componentId: "managed:review#hook:pre-tool",
        kind: "hook",
        change: "added",
        escalation: "runs a program",
      },
    ],
  },
];

/** Toolkits assigned per scope (`session`, `project`, `environment`, `graph-node`). */
const assignments = new Map<string, string[]>([["session:session-1", ["frontend"]]]);

function effective(scopeKey: string, provider: AgentPlatform): EffectiveAgentResources {
  const toolkits = assignments.get(scopeKey) ?? [];
  const graph = scopeKey.startsWith("graph-node:");
  return {
    target: { nodeId: "bk_desk", provider },
    setupRevisions: [
      { id: "my-setup", revision: 4 },
      ...toolkits.map((id) => ({ id, revision: 1 })),
    ],
    resolvedPackages: [
      { id: "managed:review", artifactDigest: DIGEST("a"), components: ["managed:review#skill:"] },
      ...(toolkits.includes("research")
        ? [
            {
              id: "git:org/agent-tools#docs-search",
              artifactDigest: DIGEST("b"),
              components: [MCP],
            },
          ]
        : []),
    ],
    permissionPolicyDigest: DIGEST("e"),
    manifestDigest: DIGEST("f"),
    unsupported: [],
    blocked:
      graph && toolkits.includes("research")
        ? [{ componentId: MCP, reason: "The node is not granted user MCP servers." }]
        : [],
    launchBlockers: [],
    warnings: [],
    resolvedAt: NOW,
  };
}

function sessionView(): CapabilitySessionView {
  const toolkits = assignments.get("session:session-1") ?? [];
  const names = toolkits.map((id) => setups.find((setup) => setup.id === id)?.name ?? id);
  return {
    sessionKey: "session-1",
    setupIds: ["my-setup", ...toolkits],
    label: ["My setup", ...names].join(" + "),
    effective: effective("session:session-1", "claude"),
    readiness: toolkits.includes("research") ? "next-session" : "ready",
    components: [
      {
        componentId: "managed:review#skill:",
        name: "review",
        kind: "skill",
        status: "ready",
        liveSemantics: "available-next-turn",
      },
      ...(toolkits.includes("research")
        ? [
            {
              componentId: MCP,
              name: "docs",
              kind: "mcp-server" as const,
              status: "installed-next-session",
              liveSemantics: "new-session-required",
              reason: "MCP servers load when a session starts.",
            },
          ]
        : []),
    ],
  };
}

const importPreview: CapabilityImportPreview = {
  previewId: "import-1",
  issues: [{ path: "packages[2].source", message: "A host path is not portable." }],
  setups: [{ name: "Frontend", action: "update", packages: 2 }],
  packages: [
    {
      packageId: "managed:review",
      action: "unchanged",
      revision: "a1b2c3d4e5f6a7b8",
      artifactDigest: DIGEST("a"),
    },
    {
      packageId: "git:org/agent-tools#docs-search",
      action: "conflict",
      revision: "1111222233334444",
      artifactDigest: DIGEST("7"),
      reason: "Your library has a newer revision",
    },
  ],
  approvalReasons: ["docs-search connects to docs.example.com."],
  valid: true,
};

function answer(command: string, args: Record<string, unknown>): unknown {
  switch (command) {
    case "list_capability_packages": {
      const query = String(args.query ?? "").toLowerCase();
      const kind = String(args.kind ?? "");
      const setupId = String(args.setupId ?? "");
      return {
        revision: 1,
        epoch: 1,
        truncated: 0,
        packages: packages.filter(
          (pkg) =>
            (!query || pkg.displayName.includes(query)) &&
            (!kind || pkg.kinds.includes(kind as never)) &&
            (!setupId || pkg.assignedSetupIds.includes(setupId)),
        ),
      };
    }
    case "get_capability_package":
      return packageDetail(String(args.packageId));
    case "read_capability_file":
      return { path: args.path, content: "# review\n\nCheck the change.", truncated: false };
    case "list_capability_setups":
      return { revision: 1, setups };
    case "list_capability_machines":
      return { machines, groups: ["development", "laptops"] };
    case "list_capability_drift":
      return {
        drift: [
          {
            id: "drift-1",
            nodeId: "bk_laptop",
            provider: "claude",
            locationId: "claude-user-skills",
            componentId: "managed:review#skill:",
            packageId: "managed:review",
            name: "review",
            kind: "modified",
            detectedAt: NOW,
            state: "open",
          },
        ],
      };
    case "list_capability_updates":
      return {
        updates: updates.filter((update) => update.state === "pending"),
        lastCheckedAt: NOW,
      };
    case "refresh_capability_updates":
      return { updates, lastCheckedAt: NOW };
    case "list_capability_activity":
      return {
        truncated: 0,
        entries: [
          {
            id: "act-1",
            at: NOW,
            actor: "you",
            action: "add",
            summary: "Added docs-search to My setup",
            packageIds: ["git:org/agent-tools#docs-search"],
            setupIds: ["my-setup"],
            correlationId: "corr-1",
          },
        ],
      };
    case "list_capability_operations": {
      const failed = operation("op-old", "add-to-setup", [
        target("t1", "bk_desk", "claude", MCP, "install", "ready"),
        target("t2", "bk_laptop", "claude", MCP, "install", "failed", {
          reason: "npx is not on this machine's PATH.",
        }),
        target("t3", "bk_build", "claude", MCP, "install", "offline"),
      ]);
      return { truncated: 0, operations: [{ ...failed, state: "partially-completed" }] };
    }
    case "inspect_capability_source":
    case "author_capability_package":
      return inspection;
    case "preview_capability_change":
      return { replayed: false, operation: addPlan(args) };
    case "apply_capability_change": {
      const applied = addPlan({ change: {} });
      return {
        replayed: false,
        operation: { ...applied, id: String(args.operationId), state: "applying" },
      };
    }
    case "preview_capability_update":
      return {
        replayed: false,
        operation: operation(
          "op-update",
          "update",
          [
            target("u1", "bk_desk", "claude", "managed:review#skill:", "update", "pending", {
              fromDigest: DIGEST("a"),
              liveSemantics: "available-next-turn",
            }),
            target(
              "u2",
              "bk_desk",
              "claude",
              "managed:review#hook:pre-tool",
              "install",
              "pending",
              {
                liveSemantics: "new-session-required",
              },
            ),
            target("u3", "bk_build", "claude", "managed:review#skill:", "update", "offline", {
              reason: "Waiting for the machine to connect.",
            }),
          ],
          ["The new revision adds a hook that runs a program."],
        ),
      };
    case "rollback_capability_package":
      return {
        replayed: false,
        operation: operation("op-rollback", "rollback", [
          target("r1", "bk_desk", "claude", "managed:review#skill:", "update", "pending", {
            sharedWith: 1,
          }),
          target("r2", "bk_laptop", "claude", "managed:review#skill:", "skip", "unsupported", {
            reason: "Exception: Frontend is not used on Laptop.",
          }),
        ]),
      };
    case "export_capability_setup":
      return {
        intentFile: "orkestrator.capabilities.yaml",
        intent: "setups:\n  - name: Frontend\n    packages:\n      - managed:review\n",
        lockFile: "orkestrator.capabilities.lock.json",
        lock: '{\n  "managed:review": "a1b2c3d4e5f6a7b8"\n}\n',
      };
    case "preview_capability_import":
      return importPreview;
    case "import_capability_setup":
      return { revision: 2, setups };
    case "assign_capability_setup": {
      const key = `${String(args.scope)}:${String(args.scopeId)}`;
      assignments.set(key, args.setupIds as string[]);
      return { setupIds: args.setupIds };
    }
    case "get_capability_assignment": {
      const key = `${String(args.scope)}:${String(args.scopeId)}`;
      return {
        scope: args.scope,
        scopeId: args.scopeId,
        setupIds: assignments.get(key) ?? [],
        revision: assignments.has(key) ? 1 : 0,
      };
    }
    case "get_effective_agent_resources": {
      const targetArgs = args.target as {
        provider: AgentPlatform;
        projectId?: string;
        environmentId?: string;
      };
      const scopeKey = args.graphNode
        ? `graph-node:${String(args.graphNode)}`
        : targetArgs.environmentId
          ? `environment:${targetArgs.environmentId}`
          : `project:${targetArgs.projectId ?? ""}`;
      return effective(scopeKey, targetArgs.provider);
    }
    case "get_capability_session_view":
      return sessionView();
    case "verify_agent_capability":
      return {
        target: args.target,
        verifiedAt: NOW,
        checks: (args.componentIds as string[]).map((componentId) => ({
          componentId,
          level: "present",
          status: "installed-next-session",
          detail: "Files present.",
        })),
      };
    case "set_capability_package_state":
    case "set_capability_setup":
    case "manage_capability_exception":
    case "set_capability_update_policy":
    case "set_capability_machine_enrollment":
    case "resolve_capability_drift":
      return {};
    default:
      return null;
  }
}

function installCapabilitiesFixture() {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const failures = new Map<string, string>();
  window.capabilityFixtureCalls = calls;
  window.capabilityFixtureFailNext = (command, message) => failures.set(command, message);
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => undefined,
    invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args: args ?? {} });
      const failure = failures.get(command);
      if (failure) {
        failures.delete(command);
        throw new Error(failure);
      }
      return answer(command, args ?? {}) as T;
    },
  } as Window["orkestrator"];
}

const menuItems = [{ id: "capabilities", label: "Capabilities", icon: null }];

function SettingsSurface() {
  const [open, setOpen] = useState(true);
  return (
    <FullscreenSettingsLayout
      open={open}
      onOpenChange={setOpen}
      title="Settings"
      menuItems={menuItems}
      defaultSection="capabilities"
    >
      {() => <CapabilitiesSettings />}
    </FullscreenSettingsLayout>
  );
}

function SessionSurface() {
  return (
    <main className="min-h-screen bg-background p-2 text-foreground">
      <div
        role="region"
        aria-label="Agent information"
        className="ml-auto w-[min(calc(100vw-1rem),23rem)] space-y-3 rounded-xl border border-border/80 bg-popover/98 p-3"
      >
        <AgentInfoCapabilitiesSection
          nodeId="bk_desk"
          environmentId="env-1"
          projectId="project-1"
          provider="claude"
          sessionKey="session-1"
          running
        />
      </div>
    </main>
  );
}

function ScopesSurface() {
  return (
    <main className="min-h-screen space-y-4 bg-background p-4 text-foreground">
      <h1 className="text-sm font-semibold">Project settings</h1>
      <CapabilityScopeCard scope="project" scopeId="project-1" projectId="project-1" />
      <h1 className="text-sm font-semibold">Environment settings</h1>
      <CapabilityScopeCard
        scope="environment"
        scopeId="env-1"
        projectId="project-1"
        environmentId="env-1"
      />
      <div className="max-w-sm rounded-md border border-border p-3">
        <FormSection title="Toolkits">
          <GraphNodeToolkitsEditor
            templateId="template-1"
            nodeId="worker"
            denied={["user-mcp"]}
            policy={undefined}
            providers={["claude"]}
          />
        </FormSection>
      </div>
    </main>
  );
}

export function CapabilitiesFixture() {
  useState(installCapabilitiesFixture);
  if (surface === "session") return <SessionSurface />;
  if (surface === "scopes") return <ScopesSurface />;
  return <SettingsSurface />;
}
