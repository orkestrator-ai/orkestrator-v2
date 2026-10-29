/**
 * Competing implementations (item 403): the smallest template that uses
 * isolated branch worktrees end to end. Three samples of a builder each
 * implement the ticket in their own worktree, a judge reads the three
 * branches and decides, and `select-workspace` fast-forwards the run's
 * branch to the winner. The tests, the mock runs and the guide use it.
 * Returns a fresh copy. Browser-safe.
 */
import type { GraphTemplateV1 } from "./template-model.js";

export const GRAPH_COMPETING_IMPLEMENTATIONS_BRANCHES = ["sample.1", "sample.2", "sample.3"];

export function graphCompetingImplementationsTemplate(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "competing-implementations",
    revision: 0,
    name: "Competing implementations",
    description:
      "Three builders implement the ticket in parallel, each in its own worktree; a judge picks one and the run's branch moves to it.",
    parameters: [],
    roles: [
      { key: "builder", multiplicity: "one" },
      { key: "judge", multiplicity: "one" },
    ],
    inputs: [
      { name: "ticket", type: "ticket@1" },
      { name: "target", type: "workspace@1" },
    ],
    outputs: [{ name: "code", type: "workspace@1", from: { node: "select", port: "code" } }],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "implement",
        kind: "agent",
        label: "Implement",
        role: "builder",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        isolation: "worktree",
        replicate: { over: "samples", count: 3 },
        prompt: {
          template:
            "Implement the ticket. Other builders implement it too, independently; make the change you think is best.\n\n{{> input.ticket}}\n\n{{> input.code}}\n",
        },
        inputs: [
          { name: "ticket", type: "ticket@1", render: "on-demand" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [
          { name: "code", type: "workspace@1" },
          { name: "notes", type: "text@1", description: "What you changed and why." },
        ],
      },
      {
        id: "judge",
        kind: "agent",
        label: "Judge",
        role: "judge",
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: {
          template:
            "Three implementations of the ticket are on the branches below, each ending in its branch key (sample.1, sample.2, sample.3). Compare them with `git diff <baseRef>..<branch>` and choose the one to keep.\n\n{{> input.ticket}}\n\n{{> input.candidates}}\n\nEach builder's notes, in the same order:\n\n{{> input.notes}}\n",
        },
        inputs: [
          { name: "ticket", type: "ticket@1", render: "on-demand" },
          { name: "candidates", type: "list<workspace@1>", render: "json-frame" },
          { name: "notes", type: "list<text@1>", render: "on-demand" },
        ],
        outputs: [
          {
            name: "decision",
            type: "decision@1",
            choices: [...GRAPH_COMPETING_IMPLEMENTATIONS_BRANCHES],
          },
        ],
      },
      {
        id: "select",
        kind: "system",
        label: "Select",
        action: "select-workspace",
        inputs: [
          { name: "candidates", type: "list<workspace@1>" },
          { name: "decision", type: "decision@1" },
        ],
        outputs: [{ name: "code", type: "workspace@1" }],
      },
    ],
    edges: [
      {
        id: "target-implement",
        from: { input: "target" },
        to: { node: "implement", port: "code" },
      },
      {
        id: "ticket-implement",
        from: { input: "ticket" },
        to: { node: "implement", port: "ticket" },
      },
      { id: "ticket-judge", from: { input: "ticket" }, to: { node: "judge", port: "ticket" } },
      {
        id: "implement-judge",
        from: { node: "implement", port: "code" },
        to: { node: "judge", port: "candidates" },
      },
      {
        id: "notes-judge",
        from: { node: "implement", port: "notes" },
        to: { node: "judge", port: "notes" },
      },
      {
        id: "implement-select",
        from: { node: "implement", port: "code" },
        to: { node: "select", port: "candidates" },
      },
      {
        id: "judge-select",
        from: { node: "judge", port: "decision" },
        to: { node: "select", port: "decision" },
      },
    ],
    limits: { maxAgentSessions: 8, maxConcurrentAgents: 4 },
  };
}
