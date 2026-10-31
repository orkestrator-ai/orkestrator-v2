/**
 * The public command contract shared by the `orkestrator` client
 * (`packages/cli`) and the backend's `public_action` gateway command.
 *
 * Everything a script can depend on lives here: the action catalogue, the
 * single JSON envelope, stable error codes and their exit classes, request
 * keys and receipts, and the limits every input is validated against. The
 * backend remains the authority for every mutation; this module only fixes
 * the shape of what crosses the wire so the CLI, the backend and the tests
 * cannot drift apart.
 *
 * The contract is deliberately separate from the internal registry commands.
 * `public_action` is the only public entrypoint; the raw registry stays an
 * internal, unstable interface that the CLI never exposes.
 */

export const PUBLIC_API_SCHEMA_VERSION = 1 as const;
export type PublicApiSchemaVersion = typeof PUBLIC_API_SCHEMA_VERSION;

/** The one registry command every public action enters through. */
export const PUBLIC_ACTION_COMMAND = "public_action";

/** Which kinds of state an action can change. Reads change none. */
export type PublicActionEffect =
  "metadata" | "filesystem" | "external-repository" | "provider-session" | "process";

/**
 * How the outcome of an action can be observed.
 *
 * - `immediate`: the response is the final result.
 * - `receipt`: the response is an admitted operation; its terminal state is
 *   read later through `run.get`.
 * - `run`: like `receipt`, plus request-specific provider execution state.
 */
export type PublicActionObservation = "immediate" | "receipt" | "run";

export type PublicMilestone = "A" | "B" | "C" | "D";

export interface PublicActionDescriptor {
  version: number;
  mutation: boolean;
  effects: readonly PublicActionEffect[];
  observation: PublicActionObservation;
  milestone: PublicMilestone;
  /** Conditions the client may wait for after this action. */
  waitConditions?: readonly string[];
  summary: string;
}

/**
 * The complete public action catalogue.
 *
 * Adding an entry here is not enough to expose an action: the backend
 * advertises an action only when a handler with the same version is
 * registered, and the CLI refuses mutations the selected backend does not
 * advertise (see `isPublicActionAvailable`).
 */
export const PUBLIC_ACTIONS = {
  capabilities: {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "Backend identity, supported actions, limits and request-key namespace.",
  },
  "project.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "List project summaries.",
  },
  "project.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "Read one project summary by ID or unique name.",
  },
  "project.add": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem"],
    observation: "receipt",
    milestone: "B",
    summary: "Register a remote, attach a backend-local checkout, or clone into a backend path.",
  },
  "project.create": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem", "external-repository"],
    observation: "receipt",
    milestone: "B",
    summary:
      "Initialize Git at a backend path, create a PRIVATE GitHub repository, and push the initial commit.",
  },
  "project.update": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "B",
    summary: "Edit stored project metadata; never moves checkouts or rewrites .git/config.",
  },
  "project.remove": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "B",
    summary:
      "Remove a project registration (with cascade, after deleting its environments); never deletes checkouts or remotes.",
  },
  "project.init": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem"],
    observation: "receipt",
    milestone: "B",
    summary:
      "Initialize a local-only Git repository (initial commit, no remote) at a backend path and register it.",
  },
  "project.config.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "B",
    summary: "Read repository settings with effective values and their source tier.",
  },
  "project.config.set": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "B",
    summary: "Atomically set/unset repository settings under a revision check.",
  },
  "environment.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "List environment summaries from the authoritative snapshot.",
  },
  "environment.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "Read one environment summary.",
  },
  "environment.create": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "B",
    summary: "Record a new environment; does not start it or launch an agent.",
  },
  "environment.start": {
    version: 1,
    mutation: true,
    effects: ["filesystem", "process"],
    observation: "receipt",
    milestone: "B",
    waitConditions: ["running", "ready"],
    summary: "Admit a backend-owned start; setup continues after the response.",
  },
  "environment.stop": {
    version: 1,
    mutation: true,
    effects: ["process"],
    observation: "receipt",
    milestone: "B",
    waitConditions: ["stopped"],
    summary: "Stop the environment's processes and container.",
  },
  "environment.recreate": {
    version: 1,
    mutation: true,
    effects: ["filesystem", "process"],
    observation: "receipt",
    milestone: "B",
    waitConditions: ["running", "ready"],
    summary:
      "Rebuild the environment's container, preserving its workspace and agent sessions; with discard, reset it and delete its local files.",
  },
  "environment.delete": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem", "process"],
    observation: "receipt",
    milestone: "B",
    waitConditions: ["deleted"],
    summary: "Stop and delete the environment, its worktree or container, and its record.",
  },
  "environment.fork": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem"],
    observation: "receipt",
    milestone: "B",
    summary: "Create a new environment from an existing environment's state.",
  },
  "environment.rename": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem"],
    observation: "receipt",
    milestone: "B",
    summary: "Rename an environment and its branch.",
  },
  "environment.config.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "B",
    summary: "Read environment settings with effective values and application timing.",
  },
  "environment.config.set": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "B",
    summary: "Atomically set/unset environment settings under a revision check.",
  },
  "environment.launch": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem", "process", "provider-session"],
    observation: "run",
    milestone: "C",
    waitConditions: ["ready"],
    summary: "Create and start an environment whose backend-owned startup sends one first prompt.",
  },
  "environment.exec": {
    version: 1,
    mutation: true,
    effects: ["filesystem", "process"],
    observation: "run",
    milestone: "D",
    summary: "Run one argv-preserving, non-PTY command inside the environment workspace.",
  },
  "agent.options": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "Enabled agents, model catalogue provenance and supported session controls.",
  },
  "session.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "List native-agent sessions of one environment without reading transcripts.",
  },
  "session.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "Read one native-agent session summary without reading its transcript.",
  },
  "session.start": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "run",
    milestone: "C",
    summary: "Start an independent native conversation and dispatch its first prompt.",
  },
  "session.prompt": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "run",
    milestone: "C",
    summary:
      "Send a follow-up prompt to one explicit idle conversation, or queue it behind a busy one.",
  },
  "session.commands": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "C",
    summary: "List the session's slash-command catalogue (IDs, availability, argument policy).",
  },
  "session.command": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "run",
    milestone: "C",
    summary:
      "Run one selected slash command; a stale or unavailable selection fails, never sends text.",
  },
  "session.stop": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Stop the current turn of one session, optionally bound to an expected run.",
  },
  "session.steer": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Steer the active turn where the provider supports it.",
  },
  "session.config.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "C",
    summary: "Read the live session's effective controls.",
  },
  "session.config.set": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Change live session controls (model, reasoning, speed, mode).",
  },
  "session.history": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "C",
    summary: "List provider conversations this session can resume.",
  },
  "session.resume": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Rebind the session to an earlier provider conversation without deleting history.",
  },
  "session.fork": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Fork the conversation into a new public session.",
  },
  "session.interactions": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "C",
    summary: "List pending questions and approvals with their permitted answers.",
  },
  "session.interaction.resolve": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Answer one exact pending interaction at an expected revision.",
  },
  "session.interaction.hold": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Pause or resume one pending interaction's countdown where its deadline is enforced.",
  },
  "session.transcript": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "C",
    summary: "Read one bounded, ordered transcript page with a continuation cursor.",
  },
  "changes.view": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "Read the backend's change projection for an environment (scope, state, line counts and their quality) with one page of changed files.",
  },
  "changes.history": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "Read one page of a session's turns, each with the backend's change projection.",
  },
  "review.launch": {
    version: 1,
    mutation: true,
    effects: ["metadata", "provider-session"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Start an environment's Multi Review, as the Multi Review button does: reviewers, consolidation, then optional Fix and PR, with saved defaults for what is omitted; an active review is reused.",
  },
  "review.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "List an environment's Multi Reviews, newest first.",
  },
  "review.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "Read one Multi Review: phase, reviewers, consolidation, Fix and PR steps.",
  },
  "review.open": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary: "Open or focus a Multi Review's root tab or its Fix tab; starts no work.",
  },
  "review.address": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Address a Multi Review's findings: hand them to its Fix session (the Address findings button).",
  },
  "review.cancel": {
    version: 1,
    mutation: true,
    effects: ["process", "provider-session"],
    observation: "receipt",
    milestone: "D",
    summary: "Cancel a running Multi Review; its record and tabs are kept.",
  },
  "build.launch": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem", "provider-session", "external-repository"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Start a Kanban ticket's Build Pipeline, as the Build button does: build, review, address, verify and PR in a new or existing environment, with per-step models, instructions and reviewer focus, and saved defaults for what is omitted; the ticket's active build is reused.",
  },
  "build.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "List a project's Build Pipelines, newest first.",
  },
  "build.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "Read one Build Pipeline: phase, iteration, and each step's agent and model with the size of its instructions and focus.",
  },
  "build.cancel": {
    version: 1,
    mutation: true,
    effects: ["process", "provider-session"],
    observation: "receipt",
    milestone: "D",
    summary: "Cancel a running Build Pipeline; its record, environment and tabs are kept.",
  },
  "graph.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "List the saved graph templates (built-in, user and, with a project, its project templates) with trust and whether each can be launched.",
  },
  "graph.show": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "Read one graph template: roles, parameters, inputs and nodes, and with a project the providers each role may run on and its launch defaults.",
  },
  "graph.validate": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "Compile a saved graph template, or a template file's JSON without saving it, and report its diagnostics and cost.",
  },
  "graph.launch": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem", "provider-session", "external-repository"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Run a saved graph template in a new worktree, a new container or an existing environment, with role models, parameters, inputs and a Kanban ticket as input; what is omitted uses the saved launch defaults.",
  },
  "graph.status": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "Read one graph run: status, node counts by state, usage and its environment, never inputs, outputs or prompts.",
  },
  "graph.cancel": {
    version: 1,
    mutation: true,
    effects: ["process", "provider-session"],
    observation: "receipt",
    milestone: "D",
    summary: "Cancel a graph run; its record, artifacts and environment are kept.",
  },
  "pr.create": {
    version: 1,
    mutation: true,
    effects: ["provider-session", "external-repository"],
    observation: "run",
    milestone: "D",
    summary:
      "Start the Create PR agent session in an environment (the PR tab): commit, push and open a pull request against the target branch. It never merges.",
  },
  "pr.resolve": {
    version: 1,
    mutation: true,
    effects: ["provider-session", "external-repository"],
    observation: "run",
    milestone: "D",
    summary:
      "Start the Resolve Conflicts agent session in an environment (the Resolve tab): merge the target branch, resolve and validate conflicts, commit and push.",
  },
  "pr.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "Read the pull request attached to an environment's branch: attachment, URL, state, draft, base and head branches, head SHA, mergeability, checks, reviewers, labels and conversation comments.",
  },
  "pr.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "List a project's pull requests from GitHub, by filter and search text.",
  },
  "pr.timeline": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "Read the timeline of an environment's pull request: commits, comments, reviews and events, oldest first.",
  },
  "pr.files": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "Read the changed files and review threads of an environment's pull request; with path, that file's diff hunks.",
  },
  "pr.options": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "Read the labels and assignable users of the repository of an environment's pull request, for pr.label and pr.reviewers.",
  },
  "pr.merge": {
    version: 1,
    mutation: true,
    effects: ["external-repository", "filesystem", "process"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Merge an environment's pull request into its target branch (the Merge button, squash by default): a draft is marked ready first and the head branch is deleted unless deleteBranch is false. With cleanup, the Merge and Cleanup button: also delete the environment and its worktree once the merge is confirmed.",
  },
  "pr.close": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary: "Close an environment's pull request without merging; pr.reopen undoes it.",
  },
  "pr.reopen": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary: "Reopen an environment's closed pull request.",
  },
  "pr.ready": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary: "Mark an environment's draft pull request ready for review.",
  },
  "pr.draft": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary: "Convert an environment's pull request back to a draft.",
  },
  "pr.comment": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary: "Add a conversation comment to an environment's pull request.",
  },
  "pr.comment.edit": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Edit a conversation comment on an environment's pull request; the GitHub user must be allowed to edit it.",
  },
  "pr.review": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Submit a review of an environment's pull request: approve, request changes or comment, with optional inline comments.",
  },
  "pr.review.comment": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary: "Add one inline review comment to a line of an environment's pull request.",
  },
  "pr.thread.reply": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary: "Reply to a review thread on an environment's pull request (threadId from pr.files).",
  },
  "pr.thread.resolve": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Resolve or unresolve a review thread on an environment's pull request (threadId from pr.files).",
  },
  "pr.file.viewed": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Mark a changed file of an environment's pull request as viewed or not viewed for the GitHub user.",
  },
  "pr.reviewers": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary: "Request or remove reviewers on an environment's pull request.",
  },
  "pr.label": {
    version: 1,
    mutation: true,
    effects: ["external-repository"],
    observation: "receipt",
    milestone: "D",
    summary: "Add or remove one label on an environment's pull request.",
  },
  "attention.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "What needs attention: pending questions and approvals, the caller's runs that settled and environments whose setup finished, since a cursor.",
  },
  "ticket.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "List a project's Kanban tickets.",
  },
  "ticket.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "Read one Kanban ticket with its description, criteria and latest comments.",
  },
  "ticket.create": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary: "Create a Kanban ticket in a project.",
  },
  "ticket.update": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary: "Change a Kanban ticket's title, description, criteria or column.",
  },
  "ticket.comment": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary: "Append a comment to a Kanban ticket.",
  },
  "mail.mailboxes": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "List agent mailboxes a message can be sent to.",
  },
  "mail.send": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Place a message in one tab's inbox; external messages are never injected into a turn.",
  },
  "node.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "List this machine and the leaf nodes (remote machines) it controls, and whether each can run actions; pass its nodeId to any other action to run it there.",
  },
  "schedule.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "List scheduled jobs with their next fire time, owner and last outcome.",
  },
  "schedule.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "Read one scheduled job with its bounded fire history.",
  },
  "schedule.create": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Schedule an action, a prompt to an agent tab or an environment launch, once or on a cron or interval.",
  },
  "schedule.update": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary: "Change a scheduled job's name, time, time zone, catch-up window or action.",
  },
  "schedule.pause": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary: "Pause a scheduled job; nothing fires until it is resumed.",
  },
  "schedule.resume": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary: "Resume a paused scheduled job from its next future slot.",
  },
  "schedule.run": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary: "Fire a scheduled job now, once, without changing its schedule.",
  },
  "schedule.delete": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary: "Delete a scheduled job and its history.",
  },
  "permission.rule.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary:
      "List this node's Orkestrator permission rules with their scope, last use and use count.",
  },
  "permission.rule.remove": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Remove an Orkestrator permission rule; matching requests ask again from the next one.",
  },
  "run.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "B",
    summary: "Read an operation by ID or by its original request key.",
  },
  "run.retry": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "run",
    milestone: "C",
    summary: "Retry the exact parked prompt/steer of an unknown dispatch under the same key.",
  },
  "run.discard": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Clear the recovery state of an unknown dispatch; does not undo an executed turn.",
  },
  "run.cancel": {
    version: 1,
    mutation: true,
    effects: ["process"],
    observation: "receipt",
    milestone: "D",
    summary: "Cancel one running exec operation's exact worker.",
  },
  "run.output": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "Read a bounded stdout/stderr window of an exec operation.",
  },
  "host.status": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "Read the host's Orkestrator version, its updater, the last check and the update job.",
  },
  "host.update.channel": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary: "Choose the host update channel and request a fresh check.",
  },
  "host.update.check": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary: "Ask the host to check for an Orkestrator update; the result arrives in host.status.",
  },
  "host.update.apply": {
    version: 1,
    mutation: true,
    effects: ["process"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Download and install an Orkestrator update on the host, restarting it after a 60 s countdown (optionally once it is idle).",
  },
  "host.update.cancel": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "D",
    summary: "Cancel the host's update before it restarts.",
  },
  "host.toolchain.repair": {
    version: 1,
    mutation: true,
    effects: ["filesystem"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Reinstall whatever of the host's pinned agent toolchain is missing or fails its digest.",
  },
  "host.image.update": {
    version: 1,
    mutation: true,
    effects: ["filesystem"],
    observation: "receipt",
    milestone: "D",
    summary:
      "Pull the release container image matching the backend and use it for new environments; lists environments to rebuild.",
  },
  "host.gh.update": {
    version: 1,
    mutation: true,
    effects: ["filesystem"],
    observation: "receipt",
    milestone: "D",
    summary: "Switch the host's gh between its pin and the newest upstream release (unqualified).",
  },
} as const satisfies Record<string, PublicActionDescriptor>;

export type PublicActionName = keyof typeof PUBLIC_ACTIONS;

export const PUBLIC_ACTION_NAMES = Object.freeze(Object.keys(PUBLIC_ACTIONS) as PublicActionName[]);

export function isPublicActionName(value: unknown): value is PublicActionName {
  return typeof value === "string" && Object.hasOwn(PUBLIC_ACTIONS, value);
}

export function isPublicMutation(action: PublicActionName): boolean {
  return PUBLIC_ACTIONS[action].mutation;
}

// ---------------------------------------------------------------------------
// Exit codes and error codes

/**
 * Process exit classes. JSON output always carries the precise error code;
 * the exit status only groups codes into classes a shell can branch on.
 */
export const PUBLIC_EXIT = Object.freeze({
  success: 0,
  failed: 1,
  invalidInput: 2,
  notFound: 3,
  connection: 4,
  deadline: 5,
  interactionRequired: 6,
  unknownDispatch: 7,
  conflict: 8,
});

/** Exit status after SIGINT/SIGTERM stopped an observer: 128 + signal. */
export const PUBLIC_SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

export const PUBLIC_ERROR_EXIT = {
  // 1 — the requested operation ran and did not succeed.
  "operation-failed": PUBLIC_EXIT.failed,
  "partial-failure": PUBLIC_EXIT.failed,
  "setup-failed": PUBLIC_EXIT.failed,
  "run-failed": PUBLIC_EXIT.failed,
  "run-cancelled": PUBLIC_EXIT.failed,
  "run-interrupted": PUBLIC_EXIT.failed,
  "exec-failed": PUBLIC_EXIT.failed,
  "store-capacity": PUBLIC_EXIT.failed,
  "internal-error": PUBLIC_EXIT.failed,
  // 2 — the caller's input was rejected before any admission.
  "invalid-input": PUBLIC_EXIT.invalidInput,
  "input-too-large": PUBLIC_EXIT.invalidInput,
  "empty-input": PUBLIC_EXIT.invalidInput,
  "unknown-command": PUBLIC_EXIT.invalidInput,
  "unknown-option": PUBLIC_EXIT.invalidInput,
  // 3 — the target does not exist, is ambiguous, or its history expired.
  "not-found": PUBLIC_EXIT.notFound,
  "ambiguous-target": PUBLIC_EXIT.notFound,
  "history-expired": PUBLIC_EXIT.notFound,
  // No node with that ID is registered on this command node.
  "node-not-found": PUBLIC_EXIT.notFound,
  // 4 — the client could not reach or authenticate to the selected backend.
  "connection-failed": PUBLIC_EXIT.connection,
  "connection-not-configured": PUBLIC_EXIT.connection,
  "profile-unavailable": PUBLIC_EXIT.connection,
  "auth-failed": PUBLIC_EXIT.connection,
  "identity-mismatch": PUBLIC_EXIT.connection,
  "response-invalid": PUBLIC_EXIT.connection,
  "transport-uncertain": PUBLIC_EXIT.connection,
  // The named leaf node is registered but not connected (or disabled).
  "node-unavailable": PUBLIC_EXIT.connection,
  // 5 — an observer's own deadline passed; the operation may still be running.
  "deadline-exceeded": PUBLIC_EXIT.deadline,
  // 130/143 — SIGINT/SIGTERM stopped the observer (see PUBLIC_SIGNAL_EXIT); the
  // table records SIGINT, and SIGTERM envelopes carry 143.
  "observation-interrupted": PUBLIC_SIGNAL_EXIT.SIGINT,
  // 6 — a pending question/approval needs an answer.
  "interaction-required": PUBLIC_EXIT.interactionRequired,
  // 7 — the provider may or may not have received the work.
  "dispatch-unknown": PUBLIC_EXIT.unknownDispatch,
  "run-unknown": PUBLIC_EXIT.unknownDispatch,
  // The command node lost a leaf's answer; the same request key replays there.
  "node-outcome-unknown": PUBLIC_EXIT.unknownDispatch,
  // 8 — conflicts, unsupported capabilities, and refused state transitions.
  conflict: PUBLIC_EXIT.conflict,
  "request-conflict": PUBLIC_EXIT.conflict,
  "revision-conflict": PUBLIC_EXIT.conflict,
  "namespace-expired": PUBLIC_EXIT.conflict,
  "namespace-closed": PUBLIC_EXIT.conflict,
  "cursor-expired": PUBLIC_EXIT.conflict,
  unsupported: PUBLIC_EXIT.conflict,
  "capability-unavailable": PUBLIC_EXIT.conflict,
  "backend-incompatible": PUBLIC_EXIT.conflict,
  busy: PUBLIC_EXIT.conflict,
  "not-ready": PUBLIC_EXIT.conflict,
  "not-empty": PUBLIC_EXIT.conflict,
  "target-mismatch": PUBLIC_EXIT.conflict,
  "session-idle": PUBLIC_EXIT.conflict,
  "interaction-stale": PUBLIC_EXIT.conflict,
  "dispatch-parked": PUBLIC_EXIT.conflict,
  // The leaf is too old to run public actions for this node, or this node is in leaf mode.
  "node-unsupported": PUBLIC_EXIT.conflict,
} as const;

export type PublicErrorCode = keyof typeof PUBLIC_ERROR_EXIT;

export function isPublicErrorCode(value: unknown): value is PublicErrorCode {
  return typeof value === "string" && Object.hasOwn(PUBLIC_ERROR_EXIT, value);
}

export function exitCodeForError(code: PublicErrorCode): number {
  return PUBLIC_ERROR_EXIT[code];
}

export interface PublicError {
  code: PublicErrorCode;
  /** Human-readable, bounded, and free of credentials, prompts and file contents. */
  message: string;
  /** True when repeating the identical request (same key) is safe and useful. */
  retryable?: boolean;
  /** Bounded, content-free structured details (IDs, stages, conflicting fields). */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Limits

export const PUBLIC_API_LIMITS = Object.freeze({
  requestIdMaxChars: 200,
  namespaceMaxChars: 64,
  idMaxChars: 200,
  nameMaxChars: 200,
  titleMaxChars: 200,
  pathMaxChars: 4096,
  gitUrlMaxChars: 2048,
  promptMaxChars: 100_000,
  promptMaxBytes: 400_000,
  steerMaxBytes: 64 * 1024,
  patchMaxBytes: 64 * 1024,
  patchMaxFields: 64,
  pageDefaultItems: 50,
  pageMaxItems: 200,
  transcriptDefaultMessages: 30,
  transcriptMaxMessages: 100,
  transcriptMaxBytes: 1024 * 1024,
  transcriptTextMaxChars: 20_000,
  interactionsMax: 32,
  historyMaxEntries: 100,
  attentionDefaultItems: 20,
  attentionMaxItems: 50,
  /** Largest decoded response the client accepts from the gateway. */
  responseMaxBytes: 8 * 1024 * 1024,
  /** Largest request body the client sends. */
  requestMaxBytes: 1024 * 1024,
  /** Fits with the maximum prompt (including JSON escaping) in the 1 MiB request. */
  promptAttachmentsMaxItems: 8,
  promptAttachmentsMaxBytes: 256 * 1024,
  promptAttachmentNameMaxChars: 128,
  commandArgumentsMaxBytes: 64 * 1024,
  execArgvMaxItems: 256,
  execArgvMaxBytes: 256 * 1024,
  execEnvMaxEntries: 64,
  // Base64 must still fit inside the 1 MiB gateway request with JSON overhead.
  execStdinMaxBytes: 700 * 1024,
  execOutputMaxBytes: 16 * 1024 * 1024,
  execOutputPageMaxBytes: 256 * 1024,
  execTimeoutDefaultMs: 30 * 60 * 1000,
  execTimeoutMaxMs: 6 * 60 * 60 * 1000,
  execConcurrencyPerEnvironment: 4,
  waitMaxMs: 24 * 60 * 60 * 1000,
});

// ---------------------------------------------------------------------------
// Request keys and operation receipts

/**
 * A caller's idempotency key. `requestId` is chosen by the caller (or
 * generated by the CLI and saved before sending); `namespace` binds it to one
 * bounded admission window, so a key whose history has been collected can
 * never be mistaken for a new one.
 */
export interface PublicRequestKey {
  requestId: string;
  /** Omitted: the backend's current namespace. */
  namespace?: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/;
const NAMESPACE_PATTERN = /^ns-[0-9]{13}-[a-f0-9]{8}$/;

export function isPublicRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PUBLIC_API_LIMITS.requestIdMaxChars &&
    REQUEST_ID_PATTERN.test(value)
  );
}

export function isPublicNamespace(value: unknown): value is string {
  return typeof value === "string" && NAMESPACE_PATTERN.test(value);
}

/** The creation time encoded in a namespace ID, or null when malformed. */
export function publicNamespaceCreatedAt(namespace: string): number | null {
  if (!isPublicNamespace(namespace)) return null;
  const value = Number(namespace.slice(3, 16));
  return Number.isSafeInteger(value) ? value : null;
}

export function formatPublicNamespace(createdAt: number, random: string): string {
  return `ns-${String(Math.max(0, Math.trunc(createdAt))).padStart(13, "0")}-${random}`;
}

/**
 * Retention contract, published in `capabilities`. A namespace admits new
 * keys for `admissionWindowMs`; every record admitted in it is retained until
 * its fence (`createdAt + admissionWindowMs + retentionMs`), and longer while
 * any of its operations is still active. Past the fence the namespace is
 * retired and every key in it is refused with `namespace-expired`.
 */
export const PUBLIC_OPERATION_RETENTION = Object.freeze({
  admissionWindowMs: 7 * 24 * 60 * 60 * 1000,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  maxOperationsPerNamespace: 5_000,
  maxRecordBytes: 8 * 1024,
  maxNamespaceBytes: 16 * 1024 * 1024,
  collectionIntervalMs: 60 * 60 * 1000,
});

export type PublicOperationState =
  | "admitted"
  | "running"
  | "succeeded"
  | "failed"
  | "partial"
  | "unknown"
  | "interrupted"
  | "cancelled";

/** States that still describe work the backend may perform or must reconcile. */
export const ACTIVE_PUBLIC_OPERATION_STATES: readonly PublicOperationState[] = Object.freeze([
  "admitted",
  "running",
  "unknown",
]);

export function isTerminalPublicOperationState(state: PublicOperationState): boolean {
  return !ACTIVE_PUBLIC_OPERATION_STATES.includes(state);
}

export interface PublicOperationResources {
  projectId?: string;
  environmentId?: string;
  sessionId?: string;
  tabId?: string;
  /** Provider dispatch request ID for prompt runs (distinct from the public key). */
  dispatchRequestId?: string;
  interactionId?: string;
  path?: string;
  remote?: string;
  forkedFromEnvironmentId?: string;
}

/** Provider admission of one prompt — separate from its execution. */
export interface PublicDispatchState {
  state: "not-sent" | "pending" | "accepted" | "rejected" | "unknown";
  origin?: "provider" | "transport";
  /** True when `run.retry`/`run.discard` can act on the parked dispatch. */
  recoverable?: boolean;
  error?: string;
}

export type PublicExecutionPhase =
  | "pending"
  | "running"
  | "waiting-for-input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown"
  | "unsupported";

export const TERMINAL_EXECUTION_PHASES: readonly PublicExecutionPhase[] = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface PublicInteractionRef {
  id: string;
  kind: string;
  revision: number;
  blocking: boolean;
  expiresAt?: number;
}

/** What happened to the work itself, with the evidence the claim rests on. */
export interface PublicExecutionState {
  state: PublicExecutionPhase;
  /** Where a terminal claim came from; absent while non-terminal. */
  evidence?:
    | "observed-turn-end"
    | "turn-outcome-record"
    | "provider-status"
    | "process-exit"
    | "lifecycle-state"
    | "none";
  error?: string;
  reason?: string;
  interactions?: PublicInteractionRef[];
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  outputLimited?: boolean;
  startedAt?: string;
  finishedAt?: string;
  observedAt?: string;
}

export interface PublicReceipt {
  /** Bounded current/final action result, also available for partial outcomes. */
  result?: Record<string, unknown>;
  operationId: string;
  namespace: string;
  requestId: string;
  action: PublicActionName;
  state: PublicOperationState;
  /** Last stage reached, e.g. `admitted`, `creating`, `starting`, `dispatching`. */
  stage: string;
  /** True when this response returned an earlier admission of the same key. */
  replayed: boolean;
  resources: PublicOperationResources;
  dispatch?: PublicDispatchState;
  execution?: PublicExecutionState;
  error?: { code: PublicErrorCode; message: string };
  /** Recorded without a payload fingerprint; changed intent cannot be detected. */
  legacyRecovery?: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** When this record stops being queryable (unless still active). */
  retainedUntil: string;
}

// ---------------------------------------------------------------------------
// Envelopes

export interface PublicConnectionIdentity {
  /** Connection or profile name as the caller selected it. */
  name: string;
  kind: "profile" | "connection";
  /** Scheme://host:port only; never credentials or query strings. */
  endpoint: string;
  installationId?: string;
  generation?: string;
}

/** Identity of the backend that produced a response; checked on every call. */
export interface PublicBackendIdentity {
  installationId: string;
  generation: string;
}

// ---------------------------------------------------------------------------
// Node targeting

/**
 * `node` value that runs an aggregate read on this node and every node it
 * controls, tagging each item with its `nodeId`.
 */
export const PUBLIC_ALL_NODES = "all";

/** Reads that accept `node: "all"`. Every other action takes one node. */
export const PUBLIC_AGGREGATE_ACTIONS: readonly PublicActionName[] = Object.freeze([
  "project.list",
  "environment.list",
  "attention.list",
]);

/** Actions that always run on the node the caller is connected to. */
export const PUBLIC_LOCAL_ONLY_ACTIONS: readonly PublicActionName[] = Object.freeze(["node.list"]);

export function isPublicAggregateAction(action: PublicActionName): boolean {
  return PUBLIC_AGGREGATE_ACTIONS.includes(action);
}

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** A syntactically valid node target: a node ID from `node.list`, or `all`. */
export function isPublicNodeTarget(value: unknown): value is string {
  return typeof value === "string" && NODE_ID_PATTERN.test(value);
}

/**
 * Which node ran a routed action. `backend` stays the node the caller is
 * connected to, so the client's identity check still holds; this names the
 * leaf whose store holds the operation and its receipt.
 */
export interface PublicNodeTag {
  nodeId: string;
  name: string;
  /** The leaf's backend generation when it answered. */
  generation?: string;
}

export interface PublicSuccessEnvelope<T = unknown> {
  schemaVersion: PublicApiSchemaVersion;
  action: string;
  ok: true;
  connection?: PublicConnectionIdentity;
  backend?: PublicBackendIdentity;
  /** Present when the action ran on another node (`request.node`). */
  node?: PublicNodeTag;
  result: T;
  receipt?: PublicReceipt;
  warnings?: string[];
}

export interface PublicErrorEnvelope {
  schemaVersion: PublicApiSchemaVersion;
  action: string;
  ok: false;
  connection?: PublicConnectionIdentity;
  backend?: PublicBackendIdentity;
  /** Present when the action was sent to another node (`request.node`). */
  node?: PublicNodeTag;
  error: PublicError & { exitCode: number };
  /** Present whenever admission may have happened, so the caller can recover. */
  receipt?: PublicReceipt;
}

export type PublicEnvelope<T = unknown> = PublicSuccessEnvelope<T> | PublicErrorEnvelope;

/** Request body of the `public_action` registry command. */
export interface PublicActionRequest {
  schemaVersion: PublicApiSchemaVersion;
  action: PublicActionName;
  /** The action version the caller was built against. */
  actionVersion: number;
  input: Record<string, unknown>;
  request?: PublicRequestKey;
  /**
   * Run on this node (a `nodeId` from `node.list`), routed by the command
   * node the caller is connected to; `all` for an aggregate read. Omitted:
   * the connected node. Send it only to a backend whose capabilities set
   * `features.nodeRouting`; an older one ignores it.
   */
  node?: string;
}

/**
 * Result of `public_action`, carried inside the legacy `{result}` gateway
 * wrapper with HTTP 200. Domain rejections are structured here; only
 * transport-level failures use the legacy `{error}` wrapper.
 */
export type PublicActionResponse<T = unknown> =
  Omit<PublicSuccessEnvelope<T>, "connection"> | Omit<PublicErrorEnvelope, "connection">;

export function publicErrorEnvelope(
  action: string,
  error: PublicError,
  receipt?: PublicReceipt,
): Omit<PublicErrorEnvelope, "connection"> {
  return {
    schemaVersion: PUBLIC_API_SCHEMA_VERSION,
    action,
    ok: false,
    error: { ...error, exitCode: exitCodeForError(error.code) },
    ...(receipt ? { receipt } : {}),
  };
}

export function publicSuccessEnvelope<T>(
  action: string,
  result: T,
  receipt?: PublicReceipt,
  warnings?: string[],
): Omit<PublicSuccessEnvelope<T>, "connection"> {
  return {
    schemaVersion: PUBLIC_API_SCHEMA_VERSION,
    action,
    ok: true,
    result,
    ...(receipt ? { receipt } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

// ---------------------------------------------------------------------------
// Capabilities

export type PublicCompletionSupport = "qualified" | "unqualified";

export interface PublicProviderCapabilities {
  completion: PublicCompletionSupport;
  completionNote?: string;
  steer: boolean;
  stop: boolean;
  resume: boolean;
  fork: boolean;
  queue: boolean;
  interactions: boolean;
  controls: {
    model: boolean;
    reasoning: boolean;
    speed: boolean;
    mode: boolean;
  };
}

export interface PublicCapabilities {
  schemaVersion: PublicApiSchemaVersion;
  backend: {
    installationId: string;
    generation: string;
    version: string;
    startedAt: string;
  };
  actions: Record<string, { version: number; available: boolean; reason?: string }>;
  limits: typeof PUBLIC_API_LIMITS;
  requestKeys: {
    currentNamespace: string;
    admissionWindowMs: number;
    retentionMs: number;
    retainedNamespaces: string[];
  };
  providers: Record<string, PublicProviderCapabilities>;
  /**
   * Optional features. Each was `false` in the first release, so a client
   * must treat a missing or `false` entry as unavailable.
   */
  features: {
    transcriptFollow: "poll" | "unavailable";
    exec: { local: boolean; container: boolean; reason?: string };
    projectCascadeRemove: boolean;
    localProjectInit: boolean;
    promptAttachments: boolean;
    selectedSlashCommands: boolean;
    enqueue: boolean;
    /** `request.node` routes an action to a leaf node (and `all` aggregates reads). */
    nodeRouting?: boolean;
  };
}

/** Whether the selected backend advertises `action` at the caller's version. */
export function isPublicActionAvailable(
  capabilities: Pick<PublicCapabilities, "actions">,
  action: PublicActionName,
): boolean {
  const entry = capabilities.actions[action];
  return entry?.available === true && entry.version === PUBLIC_ACTIONS[action].version;
}

// ---------------------------------------------------------------------------
// Validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const OPERATION_STATES: readonly PublicOperationState[] = [
  "admitted",
  "running",
  "succeeded",
  "failed",
  "partial",
  "unknown",
  "interrupted",
  "cancelled",
];

export function isPublicReceipt(value: unknown): value is PublicReceipt {
  if (!isRecord(value)) return false;
  return (
    typeof value.operationId === "string" &&
    value.operationId.length > 0 &&
    typeof value.namespace === "string" &&
    isPublicRequestId(value.requestId) &&
    isPublicActionName(value.action) &&
    OPERATION_STATES.includes(value.state as PublicOperationState) &&
    typeof value.stage === "string" &&
    typeof value.replayed === "boolean" &&
    isRecord(value.resources) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.retainedUntil === "string" &&
    (value.dispatch === undefined || isRecord(value.dispatch)) &&
    (value.execution === undefined || isRecord(value.execution)) &&
    (value.result === undefined || isRecord(value.result))
  );
}

function isEnvelopeError(value: unknown): value is PublicError & { exitCode: number } {
  return (
    isRecord(value) &&
    isPublicErrorCode(value.code) &&
    typeof value.message === "string" &&
    typeof value.exitCode === "number" &&
    (value.exitCode === exitCodeForError(value.code) ||
      (value.code === "observation-interrupted" &&
        value.exitCode === PUBLIC_SIGNAL_EXIT.SIGTERM)) &&
    (value.details === undefined || isRecord(value.details))
  );
}

/**
 * Structural validation of a `public_action` response. Unknown schema
 * versions and contradictory envelopes (ok with an error, error without a
 * code) are rejected rather than guessed at.
 */
export function isPublicActionResponse(value: unknown): value is PublicActionResponse {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== PUBLIC_API_SCHEMA_VERSION) return false;
  if (typeof value.action !== "string") return false;
  if (value.receipt !== undefined && !isPublicReceipt(value.receipt)) return false;
  if (
    value.backend !== undefined &&
    !(
      isRecord(value.backend) &&
      typeof value.backend.installationId === "string" &&
      typeof value.backend.generation === "string"
    )
  ) {
    return false;
  }
  if (
    value.node !== undefined &&
    !(
      isRecord(value.node) &&
      typeof value.node.nodeId === "string" &&
      typeof value.node.name === "string"
    )
  ) {
    return false;
  }
  if (value.ok === true) {
    return (
      Object.hasOwn(value, "result") &&
      value.error === undefined &&
      (value.warnings === undefined ||
        (Array.isArray(value.warnings) && value.warnings.every((w) => typeof w === "string")))
    );
  }
  if (value.ok === false) {
    return value.result === undefined && isEnvelopeError(value.error);
  }
  return false;
}

export function isPublicCapabilities(value: unknown): value is PublicCapabilities {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== PUBLIC_API_SCHEMA_VERSION) return false;
  const backend = value.backend;
  const keys = value.requestKeys;
  return (
    isRecord(backend) &&
    typeof backend.installationId === "string" &&
    backend.installationId.length > 0 &&
    typeof backend.generation === "string" &&
    backend.generation.length > 0 &&
    typeof backend.version === "string" &&
    isRecord(value.actions) &&
    Object.values(value.actions).every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.version === "number" &&
        typeof entry.available === "boolean",
    ) &&
    isRecord(value.limits) &&
    isRecord(keys) &&
    isPublicNamespace(keys.currentNamespace) &&
    typeof keys.admissionWindowMs === "number" &&
    typeof keys.retentionMs === "number" &&
    Array.isArray(keys.retainedNamespaces) &&
    isRecord(value.providers) &&
    isRecord(value.features)
  );
}

// ---------------------------------------------------------------------------
// Canonical intent

/**
 * Deterministic JSON for fingerprinting: object keys sorted, `undefined`
 * dropped, arrays kept in order. Two requests with the same canonical form
 * express the same intent.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Canonical JSON cannot encode a non-finite number");
    }
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Durations and wait conditions (shared by the CLI parser and the backend)

/** Parses `500ms`, `30s`, `5m`, `2h`, or bare seconds. Null when invalid. */
export function parsePublicDuration(value: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const ms = Math.round(amount * factor);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

export type PublicEnvironmentWaitCondition = "running" | "ready" | "stopped" | "deleted";
