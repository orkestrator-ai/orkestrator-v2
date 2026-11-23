/**
 * Administrator policy: entry validation and normalisation, the policy
 * revision's compare-and-swap, Activity, and the resolver blocking what the
 * policy forbids on every machine's plan. Pure state and an in-memory store.
 */
import { describe, expect, test } from "bun:test";

import {
  capabilityPolicyDenial,
  parseForbiddenComponent,
  parseForbiddenSource,
} from "@orkestrator/protocol/capability-admin-policy";
import {
  MY_SETUP_ID,
  capabilityComponentId,
  type CapabilityComponent,
  type CapabilityPackage,
} from "@orkestrator/protocol/capability-resources";

import { emptyCapabilityState, type CapabilitiesStorage } from "../storage/capabilities.js";
import { applyAdminPolicy, CapabilityAdminPolicyCommands } from "./admin-policy.js";
import { desiredStateForNode } from "./planning.js";
import { CapabilityError } from "./security.js";
import type { CapabilityState } from "./types.js";

const PACKAGE_ID = "git:github.com/org/tools//review";
const SKILL = capabilityComponentId(PACKAGE_ID, "skill", "review");
const HOOK = capabilityComponentId(PACKAGE_ID, "hook", "pre-tool");

function component(id: string, kind: CapabilityComponent["kind"]): CapabilityComponent {
  return {
    id,
    packageId: PACKAGE_ID,
    kind,
    pathOrKey: kind === "skill" ? "review" : "pre-tool",
    name: kind,
    dependencies: [],
    providerHints: [],
    requirements: {},
    risk: kind === "hook" ? "executable" : "instructions",
  };
}

/** One enrolled machine whose My setup holds a Git package with a skill and a hook. */
function stateWithPackage(): CapabilityState {
  const state = emptyCapabilityState();
  const pkg: CapabilityPackage = {
    id: PACKAGE_ID,
    source: { kind: "git", repo: "https://github.com/org/tools", subpath: "review" },
    displayName: "review",
    revision: "abc",
    artifactDigest: "sha256:review",
    componentIds: [SKILL, HOOK],
    provenance: "external",
    risk: "executable",
    createdAt: "t",
    updatedAt: "t",
  };
  state.packages[PACKAGE_ID] = pkg;
  state.components[SKILL] = component(SKILL, "skill");
  state.components[HOOK] = component(HOOK, "hook");
  state.setups[MY_SETUP_ID]!.packageSelections = [{ packageId: PACKAGE_ID, version: "latest" }];
  state.machines.n1 = { nodeId: "n1", enrolled: true, groups: [] };
  return state;
}

function memoryStorage(initial: CapabilityState): CapabilitiesStorage & { state: CapabilityState } {
  const store = {
    state: initial,
    loadCapabilityState: async () => structuredClone(store.state),
    mutateCapabilityState<T>(mutate: (state: CapabilityState) => { result: T; changed: boolean }) {
      const draft = structuredClone(store.state);
      const outcome = mutate(draft);
      if (outcome.changed) {
        draft.revision += 1;
        store.state = draft;
      }
      return outcome.result;
    },
    loadCapabilityExecutorState: async () => ({ epoch: 0, applied: {} }),
    mutateCapabilityExecutorState: <T>(mutate: (state: never) => T) => mutate({} as never),
  };
  return store as unknown as CapabilitiesStorage & { state: CapabilityState };
}

function claudeEffective(state: CapabilityState) {
  return desiredStateForNode(state, "n1", undefined).effective.find(
    (entry) => entry.target.provider === "claude",
  )!;
}

describe("policy entries", () => {
  test("source prefixes are normalised to the package id form", () => {
    expect(parseForbiddenSource("git:github.com/Org/")).toEqual({ value: "git:github.com/org/" });
    expect(parseForbiddenSource("https://github.com/Org/tools.git")).toEqual({
      value: "git:github.com/org/tools",
    });
    expect(parseForbiddenSource("git@github.com:org/")).toEqual({ value: "git:github.com/org/" });
    expect(parseForbiddenSource("registry:team")).toEqual({ value: "registry:team/" });
    expect(parseForbiddenSource("registry:team/team/review")).toEqual({
      value: "registry:team/team/review",
    });
    expect(parseForbiddenSource("git:")).toEqual({ value: "git:" });
    expect(parseForbiddenSource("marketplace:claude:")).toEqual({ value: "marketplace:claude:" });
  });

  test("source prefixes that could never match a package are refused", () => {
    for (const bad of ["", "github.com/org", "git:org", "registry:Team", "git:a b", "file:///x"]) {
      expect("error" in parseForbiddenSource(bad), bad).toBe(true);
    }
    expect("error" in parseForbiddenSource(`git:github.com/${"a".repeat(400)}`)).toBe(true);
  });

  test("components are a kind, a component id or a package id", () => {
    expect(parseForbiddenComponent("hook")).toEqual({ value: "kind:hook" });
    expect(parseForbiddenComponent("kind:mcp-server")).toEqual({ value: "kind:mcp-server" });
    expect(parseForbiddenComponent(HOOK)).toEqual({ value: HOOK });
    expect(parseForbiddenComponent(PACKAGE_ID)).toEqual({ value: PACKAGE_ID });
    for (const bad of ["kind:plugin", "review", "git:x#nokind", "git:", "x#skill:y"]) {
      expect("error" in parseForbiddenComponent(bad), bad).toBe(true);
    }
  });
});

describe("applyAdminPolicy", () => {
  test("replaces the named lists, deduplicated, and bumps the policy revision", () => {
    const state = stateWithPackage();
    const change = applyAdminPolicy(
      state,
      { expectedRevision: 0, forbiddenSources: ["git:github.com/Org/", "git:github.com/org/"] },
      "now",
    );
    expect(change).toEqual({ changed: true, added: ["git:github.com/org/"], removed: [] });
    expect(state.settings.forbiddenSources).toEqual(["git:github.com/org/"]);
    expect(state.settings.forbiddenComponents).toEqual([]);
    expect(state.settings.policyRevision).toBe(1);
    expect(state.settings.policyUpdatedAt).toBe("now");
    // The same lists again change nothing.
    expect(
      applyAdminPolicy(
        state,
        { expectedRevision: 1, forbiddenSources: ["git:github.com/org/"] },
        "",
      ).changed,
    ).toBe(false);
  });

  test("a stale revision is a conflict and a bad entry refuses the whole edit", () => {
    const state = stateWithPackage();
    applyAdminPolicy(state, { expectedRevision: 0, forbiddenComponents: ["hook"] }, "t1");
    const stale = () =>
      applyAdminPolicy(state, { expectedRevision: 0, forbiddenComponents: [] }, "t2");
    expect(stale).toThrow(CapabilityError);
    expect(stale).toThrow(/changed since it was loaded/);
    expect(() =>
      applyAdminPolicy(
        state,
        { expectedRevision: 1, forbiddenSources: ["git:github.com/ok/", "nonsense"] },
        "t3",
      ),
    ).toThrow(/"nonsense" in forbiddenSources/);
    expect(state.settings.forbiddenSources).toEqual([]);
    expect(state.settings.forbiddenComponents).toEqual(["kind:hook"]);
    expect(() => applyAdminPolicy(state, { forbiddenSources: [] }, "t4")).toThrow(
      /expectedRevision is required/,
    );
  });
});

describe("the policy over the resolver", () => {
  test("a forbidden source blocks an assigned package on every machine's plan", () => {
    const state = stateWithPackage();
    const before = claudeEffective(state);
    expect(before.resolvedPackages.map((entry) => entry.id)).toEqual([PACKAGE_ID]);
    expect(before.blocked).toEqual([]);

    applyAdminPolicy(state, { expectedRevision: 0, forbiddenSources: ["git:github.com/org/"] }, "");
    const after = claudeEffective(state);
    expect(after.resolvedPackages).toEqual([]);
    expect(after.blocked).toContainEqual({
      componentId: SKILL,
      reason: "Administrator policy forbids this source.",
    });
    expect(desiredStateForNode(state, "n1", undefined).installations).toEqual([]);
  });

  test("a repository ban covers its root package and subpaths only", () => {
    const policy = { forbiddenSources: ["git:github.com/org/tools/"] };
    const skill = component(SKILL, "skill");
    expect(capabilityPolicyDenial(policy, "git:github.com/org/tools", skill)).toBeDefined();
    expect(capabilityPolicyDenial(policy, PACKAGE_ID, skill)).toBeDefined();
    expect(capabilityPolicyDenial(policy, "git:github.com/org/tools-extra", skill)).toBeUndefined();
  });

  test("a forbidden kind blocks only that kind", () => {
    const state = stateWithPackage();
    applyAdminPolicy(state, { expectedRevision: 0, forbiddenComponents: ["kind:hook"] }, "");
    const effective = claudeEffective(state);
    expect(effective.resolvedPackages[0]?.components).toEqual([SKILL]);
    expect(effective.blocked).toContainEqual({
      componentId: HOOK,
      reason: "Administrator policy forbids every component of kind Hook.",
    });
  });
});

describe("CapabilityAdminPolicyCommands", () => {
  test("set records Activity, reconciles, and the view lists the blocked package", async () => {
    const storage = memoryStorage(stateWithPackage());
    const reconciles: string[] = [];
    const announced: string[][] = [];
    const commands = new CapabilityAdminPolicyCommands({
      storage,
      now: () => "2026-11-19T00:00:00.000Z",
      assertAuthority: () => undefined,
      announce: (ids) => announced.push(ids),
      reconcileAll: (reason) => reconciles.push(reason),
    });
    expect(await commands.get()).toMatchObject({ revision: 0, blocked: [] });

    const view = await commands.set(
      { expectedRevision: 0, forbiddenSources: ["https://github.com/org/"] },
      "agent-test",
    );
    expect(view).toEqual({
      revision: 1,
      forbiddenSources: ["git:github.com/org/"],
      forbiddenComponents: [],
      updatedAt: "2026-11-19T00:00:00.000Z",
      blocked: [
        {
          packageId: PACKAGE_ID,
          displayName: "review",
          entry: "git:github.com/org/",
          assigned: true,
        },
      ],
      blockedTruncated: 0,
    });
    const activity = Object.values(storage.state.activity);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      action: "admin-policy",
      actor: "agent-test",
      summary: "Administrator policy: forbade git:github.com/org/.",
      packageIds: [PACKAGE_ID],
    });
    expect(reconciles).toEqual(["admin-policy"]);
    expect(announced).toEqual([[PACKAGE_ID]]);

    // A second administrator still holding revision 0 is refused; nothing is recorded.
    await expect(
      commands.set({ expectedRevision: 0, forbiddenSources: [] }, "agent-test"),
    ).rejects.toThrow(/changed since it was loaded/);
    expect(Object.values(storage.state.activity)).toHaveLength(1);

    await commands.set({ expectedRevision: 1, forbiddenSources: [] });
    expect(Object.values(storage.state.activity).map((entry) => entry.summary)).toContain(
      "Administrator policy: allowed git:github.com/org/ again.",
    );
    expect(reconciles).toEqual(["admin-policy", "admin-policy"]);
  });

  test("a follower machine refuses the edit", async () => {
    const commands = new CapabilityAdminPolicyCommands({
      storage: memoryStorage(stateWithPackage()),
      now: () => "",
      assertAuthority: () => {
        throw new CapabilityError("conflict", "This machine follows a command node.");
      },
      announce: () => undefined,
      reconcileAll: () => undefined,
    });
    await expect(commands.set({ expectedRevision: 0, forbiddenSources: [] })).rejects.toThrow(
      /follows a command node/,
    );
  });
});
