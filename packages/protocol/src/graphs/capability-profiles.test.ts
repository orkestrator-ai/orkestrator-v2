import { describe, expect, test } from "bun:test";
import { coordinatorCapabilityPolicy } from "../coordinator-web-research.js";
import type { NativeAgentExecutionPolicy } from "../native-agent.js";
import {
  checkGraphCapabilities,
  checkGraphWorkspaceAccess,
  compileGraphCapabilities,
  DEFAULT_GRAPH_CAPABILITY_CEILING,
  defaultGraphMinEnforcement,
  describeGraphCapabilities,
  effectiveGraphMinEnforcement,
  GRAPH_CAPABILITY_PROFILE_DEFINITIONS,
  graphCapabilityCeilingIssues,
  graphCapabilitySpecRequestsRemoteWrite,
  graphGrantedActionNames,
  graphGrantedActions,
  graphMinEnforcementLowered,
  isGraphCapabilityCeiling,
} from "./capability-profiles.js";
import { GRAPH_CAPABILITY_PROFILES, type GraphCapabilitySpec } from "./template-model.js";

// The three environments `resolveNativeAgentExecutionPolicy` produces for a
// workflow session, as plain values (the backend property test uses the
// resolver itself).
const host: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};
const container: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "container",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "restricted",
  toolPolicy: { deny: ["custom-tool"] },
};
const coordinator: NativeAgentExecutionPolicy = {
  id: "coordinator-read-only",
  sandbox: "provider",
  approvals: "deny",
  projectResources: false,
  toolPolicy: { deny: ["write", "edit", "apply_patch", "shell"] },
  capabilityPolicy: coordinatorCapabilityPolicy("search"),
  networkAccess: "restricted",
};

const compile = (
  spec: GraphCapabilitySpec,
  environment: NativeAgentExecutionPolicy = host,
  ceiling = DEFAULT_GRAPH_CAPABILITY_CEILING,
) => compileGraphCapabilities({ spec, environment, ceiling });

describe("capability profiles", () => {
  test("there is no shipper, and every profile denies push and GitHub writes (D12)", () => {
    expect(Object.keys(GRAPH_CAPABILITY_PROFILE_DEFINITIONS)).toEqual([
      ...GRAPH_CAPABILITY_PROFILES,
    ]);
    expect(GRAPH_CAPABILITY_PROFILES as readonly string[]).not.toContain("shipper");
    for (const profile of GRAPH_CAPABILITY_PROFILES) {
      for (const environment of [host, container, coordinator]) {
        const compiled = compile(
          // Even a node that asks for them, and one that allows everything else.
          { profile, allow: ["git.push", "github.write", "network", "shell"] },
          environment,
        );
        expect(compiled.denied).toContain("git.push");
        expect(compiled.denied).toContain("github.write");
      }
    }
  });

  test("maps each profile onto a host environment", () => {
    const denied = Object.fromEntries(
      GRAPH_CAPABILITY_PROFILES.map((profile) => [profile, compile({ profile }).denied]),
    );
    expect(denied).toEqual({
      observer: [
        "file.write",
        "file.patch",
        "shell",
        "shell.mutate",
        "network",
        "git.commit",
        "git.push",
        "github.write",
        "subagents",
      ],
      reviewer: [
        "file.write",
        "file.patch",
        "shell.mutate",
        "network",
        "git.commit",
        "git.push",
        "github.write",
      ],
      verifier: ["file.write", "file.patch", "git.commit", "git.push", "github.write"],
      researcher: [
        "file.write",
        "file.patch",
        "shell",
        "shell.mutate",
        "network",
        "git.commit",
        "git.push",
        "github.write",
      ],
      builder: ["git.push", "github.write"],
      custom: ["git.push", "github.write"],
    });
    const researcher = compile({ profile: "researcher" });
    expect(researcher.webSearch).toBe(true);
    expect(researcher.policy.capabilityPolicy).toEqual({
      deny: researcher.denied,
      allow: ["web.search"],
    });
    expect(compile({ profile: "observer" }).webSearch).toBe(false);
    // Everything but the capability policy is the environment's.
    for (const profile of GRAPH_CAPABILITY_PROFILES) {
      const { capabilityPolicy: _, ...rest } = compile({ profile }).policy;
      expect(rest).toEqual(host);
    }
    expect(GRAPH_CAPABILITY_PROFILES.filter((profile) => compile({ profile }).readOnly)).toEqual([
      "observer",
      "reviewer",
      "researcher",
    ]);
  });

  test("maps each profile onto a container environment", () => {
    for (const profile of GRAPH_CAPABILITY_PROFILES) {
      const compiled = compile({ profile }, container);
      const { capabilityPolicy: _, ...rest } = compiled.policy;
      expect(rest).toEqual(container);
      expect(compiled.policy.toolPolicy).not.toBe(container.toolPolicy);
      expect(compiled.removedByEnvironment).toEqual([]);
    }
  });

  test("maps each profile onto the coordinator environment, which only narrows it", () => {
    const builder = compile({ profile: "builder" }, coordinator);
    expect(builder.policy.id).toBe("coordinator-read-only");
    expect(builder.readOnly).toBe(true);
    expect(builder.denied).toEqual([
      "file.write",
      "file.patch",
      "shell.mutate",
      "network",
      "git.push",
      "github.write",
    ]);
    // The coordinator's research exception survives for a profile that wants it…
    expect(builder.webSearch).toBe(true);
    expect(builder.policy.capabilityPolicy?.allow).toEqual(["web.search"]);
    expect(builder.removedByEnvironment).toEqual([
      "file.write",
      "file.patch",
      "shell.mutate",
      "network",
    ]);
    // …and not for one that denies it.
    const observer = compile({ profile: "observer" }, coordinator);
    expect(observer.webSearch).toBe(false);
    expect(observer.policy.capabilityPolicy?.allow).toBeUndefined();
    // An environment without the exception takes it from a researcher.
    const noSearch = { ...coordinator, capabilityPolicy: coordinatorCapabilityPolicy("off") };
    const researcher = compile({ profile: "researcher" }, noSearch);
    expect(researcher.webSearch).toBe(false);
    expect(researcher.removedByEnvironment).toEqual(["web.search"]);
  });

  test("node overrides deny more and carve exceptions out of the profile", () => {
    const fullNetwork = compile({ profile: "researcher", allow: ["network"] });
    expect(fullNetwork.denied).not.toContain("network");
    expect(fullNetwork.webSearch).toBe(true);
    expect(fullNetwork.policy.capabilityPolicy?.allow).toBeUndefined();

    const reviewerSearch = compile({ profile: "reviewer", allow: ["web.search"] });
    expect(reviewerSearch.webSearch).toBe(true);
    expect(reviewerSearch.policy.capabilityPolicy?.allow).toEqual(["web.search"]);

    const quietBuilder = compile({
      profile: "builder",
      deny: ["web.search", "subagents", "mcp:docs", "orkestrator:mail"],
      allow: ["orkestrator:mail", "orkestrator:tickets.read", "mcp:other"],
    });
    expect(quietBuilder.denied).toEqual([
      "web.search",
      "git.push",
      "github.write",
      "subagents",
      "mcp:docs",
    ]);
    expect(quietBuilder.webSearch).toBe(false);
    // A deny wins over an allow of the same group; an MCP grant does nothing.
    expect(quietBuilder.orkestratorGroups).toEqual(["tickets.read"]);

    const observerShell = compile({ profile: "observer", allow: ["shell"] });
    expect(observerShell.denied).toContain("shell.mutate");
    expect(observerShell.denied).not.toContain("shell");
    expect(observerShell.readOnly).toBe(true);
  });

  test("the project ceiling narrows every node and reports what it took (D18)", () => {
    const ceiling = {
      deny: ["network", "subagents", "orkestrator:tickets.write", "mcp:docs"],
      allow: ["web.search"],
    } as const;
    expect(isGraphCapabilityCeiling(ceiling)).toBe(true);
    const builder = compileGraphCapabilities({
      spec: { profile: "builder", allow: ["orkestrator:tickets.write", "orkestrator:mail"] },
      environment: host,
      ceiling: { deny: [...ceiling.deny], allow: [...ceiling.allow] },
    });
    expect(builder.denied).toEqual([
      "network",
      "git.push",
      "github.write",
      "subagents",
      "mcp:docs",
      "orkestrator:tickets.write",
    ]);
    expect(builder.webSearch).toBe(true);
    expect(builder.orkestratorGroups).toEqual(["mail"]);
    expect(builder.removedByCeiling).toEqual([
      "network",
      "subagents",
      "mcp:docs",
      "orkestrator:tickets.write",
    ]);
    // A ceiling without the search exception takes search away too.
    const noSearch = compileGraphCapabilities({
      spec: { profile: "researcher" },
      environment: host,
      ceiling: { deny: ["network"] },
    });
    expect(noSearch.webSearch).toBe(false);
    expect(noSearch.removedByCeiling).toEqual(["web.search"]);
  });

  test("the ceiling is validated, and push or GitHub writes are outside it", () => {
    expect(graphCapabilityCeilingIssues(DEFAULT_GRAPH_CAPABILITY_CEILING)).toEqual([]);
    expect(graphCapabilityCeilingIssues({ deny: ["git.push"] })[0]?.message).toContain(
      "outside the ceiling",
    );
    expect(graphCapabilityCeilingIssues({ deny: ["network", "network"] })[0]?.path).toBe("deny[1]");
    expect(graphCapabilityCeilingIssues({ deny: ["fs.write"] })[0]?.path).toBe("deny[0]");
    expect(graphCapabilityCeilingIssues({ deny: [], allow: ["network"] })[0]?.path).toBe("allow");
    expect(graphCapabilityCeilingIssues({ deny: [], extra: 1 })[0]?.path).toBe("extra");
    expect(graphCapabilityCeilingIssues(null)[0]?.path).toBe("$");
    expect(graphCapabilityCeilingIssues({ deny: Array(65).fill("network") })[0]?.message).toContain(
      "At most",
    );
  });

  test("defaults the enforcement floor for profiles that deny writes (D4)", () => {
    const floors = Object.fromEntries(
      GRAPH_CAPABILITY_PROFILES.map((profile) => [
        profile,
        defaultGraphMinEnforcement(compile({ profile })) ?? null,
      ]),
    );
    expect(floors).toEqual({
      observer: "provider-configured",
      reviewer: "provider-configured",
      verifier: null,
      researcher: "provider-configured",
      builder: null,
      custom: null,
    });
    const reviewer = compile({ profile: "reviewer" });
    expect(
      compile({ profile: "custom", deny: ["file.write", "file.patch", "shell"] })
        .defaultMinEnforcement,
    ).toBe("provider-configured");
    expect(effectiveGraphMinEnforcement(undefined, reviewer)).toBe("provider-configured");
    expect(effectiveGraphMinEnforcement("enforced", reviewer)).toBe("enforced");
    expect(graphMinEnforcementLowered("advisory", reviewer)).toBe(true);
    expect(graphMinEnforcementLowered("enforced", reviewer)).toBe(false);
    expect(graphMinEnforcementLowered("advisory", compile({ profile: "builder" }))).toBe(false);
  });
});

describe("capability checks for the compiler", () => {
  test("rejects push and GitHub writes, and MCP grants", () => {
    const spec: GraphCapabilitySpec = {
      profile: "custom",
      allow: ["git.push", "github.write", "mcp:docs"],
    };
    expect(graphCapabilitySpecRequestsRemoteWrite(spec)).toBe(true);
    expect(graphCapabilitySpecRequestsRemoteWrite({ profile: "builder" })).toBe(false);
    expect(
      checkGraphCapabilities(spec, "write").map((issue) => [issue.code, issue.capability]),
    ).toEqual([
      ["capability-remote-write", "git.push"],
      ["capability-remote-write", "github.write"],
      ["capability-mcp-grant", "mcp:docs"],
    ]);
  });

  test("warns about an allow that changes nothing", () => {
    const issues = checkGraphCapabilities(
      { profile: "builder", allow: ["network", "orkestrator:mail"] },
      "write",
    );
    expect(issues).toEqual([
      expect.objectContaining({
        code: "capability-allow-unused",
        severity: "warning",
        capability: "network",
      }),
    ]);
    expect(
      checkGraphCapabilities({ profile: "researcher", allow: ["web.search"] }, "read")[0]?.code,
    ).toBe("capability-allow-unused");
    expect(checkGraphCapabilities({ profile: "reviewer", allow: ["web.search"] }, "read")).toEqual(
      [],
    );
  });

  test("workspaceAccess must agree with the profile", () => {
    const agrees = (profile: GraphCapabilitySpec["profile"], access: "none" | "read" | "write") =>
      checkGraphWorkspaceAccess({ profile }, access).length === 0;
    expect(GRAPH_CAPABILITY_PROFILES.filter((profile) => agrees(profile, "write"))).toEqual([
      "builder",
      "custom",
    ]);
    expect(GRAPH_CAPABILITY_PROFILES.filter((profile) => agrees(profile, "read"))).toEqual([
      "observer",
      "reviewer",
      "verifier",
      "researcher",
    ]);
    expect(GRAPH_CAPABILITY_PROFILES.filter((profile) => agrees(profile, "none"))).toEqual([
      "observer",
      "reviewer",
      "verifier",
      "researcher",
    ]);
    expect(checkGraphWorkspaceAccess({ profile: "reviewer" }, "write")[0]?.code).toBe(
      "capability-workspace-write-denied",
    );
    expect(checkGraphWorkspaceAccess({ profile: "builder" }, "read")[0]?.code).toBe(
      "capability-workspace-read-writable",
    );
    // A custom node that gives up its file tools reads; one that carves them back writes.
    expect(
      checkGraphWorkspaceAccess({ profile: "custom", deny: ["file.write", "file.patch"] }, "read"),
    ).toEqual([]);
    expect(
      checkGraphWorkspaceAccess(
        { profile: "reviewer", allow: ["file.write", "file.patch"] },
        "write",
      ),
    ).toEqual([]);
  });
});

describe("granted actions", () => {
  test("submit, validate and status always; the rest by the node's shape and opt-ins", () => {
    const actions = graphGrantedActions({
      outputs: [
        { name: "report", type: "review-report@1" },
        { name: "summary", type: "text@1" },
      ],
      inputs: [{ name: "code", render: "on-demand" }, { name: "brief" }],
      askHuman: true,
      orkestratorGroups: ["tickets.read", "mail"],
      typeHasItems: (type) => type === "review-report@1",
    });
    expect(actions).toMatchObject({
      submit: ["report", "summary"],
      validate: ["report", "summary"],
      status: true,
      reportProgress: ["report"],
      readArtifact: true,
      askHuman: true,
    });
    expect(actions.orkestrator.map((entry) => entry.group)).toEqual(["tickets.read", "mail"]);
    const names = graphGrantedActionNames(actions);
    for (const name of [
      "submit_report",
      "validate_summary",
      "get_workflow_result_status",
      "report_progress",
      "read_artifact",
      "ask_human",
      "get_ticket",
      "send_message",
    ]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("create_ticket");
  });

  test("a plain node gets only its result tools", () => {
    const actions = graphGrantedActions({
      outputs: [{ name: "result", type: "text@1" }],
      orkestratorGroups: [],
      typeHasItems: () => false,
    });
    expect(graphGrantedActionNames(actions)).toEqual([
      "get_workflow_result_status",
      "submit_result",
      "validate_result",
    ]);
  });
});

describe("capability statement", () => {
  test("a reviewer is told it reads only, has no network and cannot push", () => {
    const compiled = compile({ profile: "reviewer" });
    const statement = describeGraphCapabilities({
      compiled,
      actions: graphGrantedActions({ orkestratorGroups: [], typeHasItems: () => false }),
      enforcement: { tier: "advisory" },
    });
    expect(statement).toBe(
      [
        "Capabilities (reviewer profile):",
        "- You may read the workspace but must not change it: you cannot create, edit or delete files.",
        "- Your shell is read-only: run only commands that read, such as git diff, git log or git show.",
        "- You have no network access; hosted web search and web fetch are off.",
        "- You cannot create commits.",
        "- You cannot push or write to GitHub (pull requests, comments, labels); Orkestrator's system steps do that after you finish.",
        "- Nobody is watching this step: do not ask the user questions; decide, and say what you assumed.",
        "- Some of these limits are not enforced by your provider. They are checked after you finish, and a violation fails this step.",
      ].join("\n"),
    );
  });

  test("covers builders, verifiers, researchers and opt-ins", () => {
    const builder = describeGraphCapabilities({
      compiled: compile({
        profile: "builder",
        deny: ["subagents", "mcp:docs"],
        allow: ["orkestrator:tickets.write"],
      }),
      enforcement: { tier: "enforced" },
    });
    expect(builder).toContain("You may create, edit and delete files");
    expect(builder).toContain("You may commit your work locally.");
    expect(builder).toContain("You cannot start sub-agents.");
    expect(builder).toContain("You cannot use these MCP servers: docs.");
    expect(builder).toContain("creating and updating tickets");
    expect(builder).not.toContain("not enforced");

    const verifier = describeGraphCapabilities({ compiled: compile({ profile: "verifier" }) });
    expect(verifier).toContain("You cannot create, edit or delete files with your file tools.");
    expect(verifier).toContain("must leave tracked files as you found them");

    const researcher = describeGraphCapabilities({ compiled: compile({ profile: "researcher" }) });
    expect(researcher).toContain("You have no shell.");
    expect(researcher).toContain("except hosted web search");

    const asking = describeGraphCapabilities({
      compiled: compile({ profile: "observer" }),
      actions: graphGrantedActions({
        askHuman: true,
        orkestratorGroups: [],
        typeHasItems: () => false,
      }),
    });
    expect(asking).toContain("ask_human");
    expect(asking).toContain("You cannot start sub-agents.");
  });
});
