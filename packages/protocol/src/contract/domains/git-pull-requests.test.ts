/**
 * The `git` and `pull-requests` domains (plan item 7006): their definitions
 * classify reads as the routing classifier does, keep the handlers' error
 * text, keep model records open, and their clients send typed, enveloped
 * calls to a node with the domain while a pre-contract node gets today's
 * untyped calls.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { CHANGE_TRACKING_PROTOCOL_CAPABILITY } from "../../change-resources.js";
import { isNodeReadCommand } from "../../command-nodes.js";
import type { NegotiatedDomains } from "../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../client.js";
import { DOMAIN_CLIENTS } from "../client-adapters.js";
import {
  decodeCommandArgs,
  decodeCommandResult,
  validateCommandResult,
  type AnyCommandDef,
} from "../command.js";
import {
  GIT_CHANGE_TRACKING_PROTOCOL,
  GIT_COMMANDS,
  changesGetViewCommand,
  changesPrepareRestoreCommand,
  getGitStatusCommand,
  gitClient,
  gitDomain,
} from "./git/index.js";
import {
  GitHubIssueDetailSchema,
  PULL_REQUESTS_COMMANDS,
  getGitHubPullRequestCommand,
  getPrMonitorStateCommand,
  mergeEnvironmentPrCommand,
  pullRequestsClient,
  pullRequestsDomain,
} from "./pull-requests/index.js";

const ADMIN = new Set(["changes_get_diagnostics"]);
const INTERNAL = new Set(["pr_monitor_agent_turn_completed", "pr_monitor_probe_environment"]);

const DOMAINS = [
  { domain: gitDomain, commands: GIT_COMMANDS as readonly AnyCommandDef[], count: 23 },
  {
    domain: pullRequestsDomain,
    commands: PULL_REQUESTS_COMMANDS as readonly AnyCommandDef[],
    count: 42,
  },
];

describe("git and pull-requests definitions", () => {
  for (const { domain, commands, count } of DOMAINS) {
    it(`defines ${domain.name}'s ${count} commands once each, at version 1`, () => {
      const names = commands.map((def) => def.name);
      expect(names).toHaveLength(count);
      expect(new Set(names).size).toBe(count);
      expect(domain).toMatchObject({ version: 1, min: 1 });
      for (const def of commands) {
        expect(def.domain).toBe(domain);
        expect(def.since).toBe(1);
        expect(def.encoded).toBe(false);
      }
    });

    it(`classifies ${domain.name}'s reads with the routing classifier and access as recorded`, () => {
      for (const def of commands) {
        expect({ name: def.name, read: def.read }).toEqual({
          name: def.name,
          read: isNodeReadCommand(def.name),
        });
        const access = ADMIN.has(def.name)
          ? "admin"
          : INTERNAL.has(def.name)
            ? "internal"
            : "workspace";
        expect({ name: def.name, access: def.access }).toEqual({ name: def.name, access });
      }
    });

    it(`exports every ${domain.name} schema as JSON Schema`, () => {
      for (const def of commands) {
        expect(() => Schema.toJsonSchemaDocument(def.args)).not.toThrow();
        expect(() => Schema.toJsonSchemaDocument(def.result)).not.toThrow();
      }
    });
  }

  it("lists both clients in DOMAIN_CLIENTS with adapters 1 and 0", () => {
    expect(DOMAIN_CLIENTS).toContain(gitClient);
    expect(DOMAIN_CLIENTS).toContain(pullRequestsClient);
    expect(gitClient.versions).toEqual([1, 0]);
    expect(pullRequestsClient.versions).toEqual([1, 0]);
  });

  it("drops unknown keys of a formerly strict command, refuses an unknown critical one", () => {
    const decoded = decodeCommandArgs(getGitHubPullRequestCommand, {
      owner: "o",
      repo: "r",
      number: 1,
      future: true,
    });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).not.toHaveProperty("future");
    const refused = decodeCommandArgs(
      getGitHubPullRequestCommand,
      { owner: "o", repo: "r", number: 1, future: true },
      { critical: ["future"] },
    );
    expect(refused._tag).toBe("Failure");
  });

  it("accepts optional arguments an in-process caller sends as undefined", () => {
    expect(
      decodeCommandArgs(mergeEnvironmentPrCommand, {
        environmentId: "env-1",
        method: "squash",
        expectedHeadSha: undefined,
        autoMergeEnabledAt: undefined,
      })._tag,
    ).toBe("Success");
  });

  it("keeps every key of a change projection through a tolerant decode", () => {
    const view = {
      kind: "projection",
      projection: {
        schemaVersion: 1,
        resourceKey: "environment-net/environment/env-1/live",
        ownerGeneration: "g1",
        revision: 4,
        measurementId: "m1",
        state: "ready",
        availability: "ready",
        observationState: "fresh",
        hasFileChanges: true,
        hasTextChanges: true,
        counters: {
          additions: { value: 3, quality: "exact", bound: "exact" },
          deletions: { value: 1, quality: "exact", bound: "exact" },
          changedFiles: 1,
        },
        reasonKeys: [],
        detail: null,
        filePage: null,
        actions: [{ kind: "refresh", targetToken: "t", enabled: true, reasonKey: null }],
        freshness: { observedAt: null },
      },
    };
    const decoded = decodeCommandResult(changesGetViewCommand, view);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success as unknown).toEqual(view);
    // A declared field is still type-checked.
    expect(
      validateCommandResult(changesGetViewCommand, {
        kind: "projection",
        projection: { revision: "4" },
      })._tag,
    ).toBe("Failure");
    // A newer kind still decodes.
    expect(decodeCommandResult(changesGetViewCommand, { kind: "later" })._tag).toBe("Success");
  });

  it("answers both forms of a conditional snapshot read", () => {
    const snapshot = { generation: "g", revision: 2, entries: [] };
    expect(decodeCommandResult(getPrMonitorStateCommand, snapshot)._tag).toBe("Success");
    expect(
      decodeCommandResult(getPrMonitorStateCommand, {
        status: "unchanged",
        generation: "g",
        revision: 2,
      })._tag,
    ).toBe("Success");
    expect(decodeCommandResult(getGitStatusCommand, [])._tag).toBe("Success");
    expect(decodeCommandResult(getGitStatusCommand, { unchanged: true, digest: "d" })._tag).toBe(
      "Success",
    );
  });

  it("describes a GitHub issue field for field", () => {
    const issue = {
      id: 1,
      number: 7,
      title: "Bug",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/7",
      state: "open",
      locked: false,
      author: null,
      assignees: [],
      labels: [{ name: "ork:todo", color: "ffffff" }],
      commentsCount: 0,
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z",
      status: "todo",
      comments: [],
    };
    expect(Schema.decodeUnknownSync(GitHubIssueDetailSchema)(issue) as unknown).toEqual(issue);
    expect(
      Schema.decodeUnknownResult(GitHubIssueDetailSchema)({ ...issue, status: "done" })._tag,
    ).toBe("Failure");
  });

  it("names the change-tracking protocol version 1 includes", () => {
    expect(GIT_CHANGE_TRACKING_PROTOCOL).toEqual({
      capability: CHANGE_TRACKING_PROTOCOL_CAPABILITY,
      history: true,
      gitScopes: true,
      operationVolume: true,
    });
  });
});

interface Sent {
  command: string;
  args: unknown;
  envelope: ContractEnvelopeFields | undefined;
}

function fakeNode(domains: NegotiatedDomains | undefined, answer: (command: string) => unknown) {
  const sent: Sent[] = [];
  const invoked: Array<{ command: string; args: unknown }> = [];
  const usage: Array<[string, number]> = [];
  const options = {
    call: async (def: AnyCommandDef, args: unknown, envelope?: ContractEnvelopeFields) => {
      sent.push({ command: def.name, args, envelope });
      return answer(def.name);
    },
    invoke: async (command: string, args?: Readonly<Record<string, unknown>>) => {
      invoked.push({ command, args });
      return answer(command);
    },
    domains,
    usage: (domain: string, version: number) => usage.push([domain, version]),
  };
  return { sent, invoked, usage, options };
}

describe("git client", () => {
  it("version 1: enveloped calls with their critical keys, decoded results", async () => {
    const node = fakeNode({ git: { min: 1, max: 1 } }, () => ({
      kind: "disabled",
      reasonKey: "changes.restore.disabled",
      extra: "kept",
    }));
    const client = createDomainClient(gitClient, node.options);
    expect(client.version()).toBe(1);
    const args = { measurementId: "m1", pathIds: ["p1"] };
    await expect(client.api().changes_prepare_restore(args) as Promise<unknown>).resolves.toEqual({
      kind: "disabled",
      reasonKey: "changes.restore.disabled",
      extra: "kept",
    });
    expect(node.sent).toEqual([
      {
        command: changesPrepareRestoreCommand.name,
        args,
        envelope: { domain: "git", version: 1, critical: ["pathIds"] },
      },
    ]);
    expect(node.invoked).toEqual([]);
    expect(node.usage).toEqual([]);
  });

  it("version 0: today's untyped call, answered as sent, counted", async () => {
    const node = fakeNode(undefined, () => ({ legacy: true }));
    const client = createDomainClient(gitClient, node.options);
    expect(client.version()).toBe(0);
    await expect(
      client.api().changes_get_view({ resourceKey: "k" }) as Promise<unknown>,
    ).resolves.toEqual({
      legacy: true,
    });
    expect(node.invoked).toEqual([{ command: "changes_get_view", args: { resourceKey: "k" } }]);
    expect(node.sent).toEqual([]);
    expect(node.usage).toEqual([["git", 0]]);
  });

  it("refuses a node whose range does not overlap", () => {
    const node = fakeNode({ git: { min: 2, max: 3 } }, () => null);
    const client = createDomainClient(gitClient, node.options);
    expect(() => client.api()).toThrow();
  });
});

describe("pull-requests client", () => {
  it("version 1: the merge guards travel as critical keys", async () => {
    const node = fakeNode({ "pull-requests": { min: 1, max: 1 } }, () => ({
      outcome: "merged",
      cleanupOutcome: "not-requested",
    }));
    const client = createDomainClient(pullRequestsClient, node.options);
    const args = {
      environmentId: "env-1",
      method: "squash",
      expectedHeadSha: "a".repeat(40),
      expectedPrUrl: "https://github.com/o/r/pull/1",
    };
    await expect(client.api().merge_environment_pr(args)).resolves.toEqual({
      outcome: "merged",
      cleanupOutcome: "not-requested",
    });
    expect(node.sent[0]?.envelope).toEqual({
      domain: "pull-requests",
      version: 1,
      critical: ["expectedHeadSha", "expectedPrUrl", "method"],
    });
  });

  it("version 0: today's untyped call, answered as sent", async () => {
    const node = fakeNode({ git: { min: 1, max: 1 } }, () => ({ older: "shape" }));
    const client = createDomainClient(pullRequestsClient, node.options);
    expect(client.version()).toBe(0);
    const ref = { owner: "o", repo: "r", number: 3 };
    await expect(client.api().get_github_pull_request(ref) as Promise<unknown>).resolves.toEqual({
      older: "shape",
    });
    expect(node.invoked).toEqual([{ command: "get_github_pull_request", args: ref }]);
    expect(node.usage).toEqual([["pull-requests", 0]]);
  });
});
