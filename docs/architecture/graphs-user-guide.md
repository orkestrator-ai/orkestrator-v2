# Graphs: user guide

How to design, test, launch, watch and share a graph. How it works inside is
in [graphs.md](graphs.md).

A **graph** is a workflow you draw: agent steps, system steps (push, open a
pull request, move a ticket), gates, merges and human checkpoints, joined by
edges that carry typed results from one step to the next. Loops repeat a part
of the graph a bounded number of times. Graphs live in the **Graphs** tab of
an environment.

## Designing a graph

### Open the designer

Click **Graphs** (the network icon) in an environment's action bar. There is
one Graphs tab per environment. On the left is the **Library**:

- **Built-in**: Multi Review, Build Pipeline and Looped Review. They describe
  the flows Orkestrator runs on their own engines, so you cannot edit or run
  them as graphs. Looped Review's engine is retired and is marked so.
- **Yours**: your own templates, stored by the app.
- **Project**: `.orkestrator/graphs/*.graph.json` files in the project's
  repository. They come from whoever wrote the repository, so they are
  *untrusted* until you approve them (see [Sharing and trust](#sharing-and-trusting-templates)).

Each entry shows its compile result (errors and warnings). Select one to see
it on the canvas; the inspector on the right describes whatever you select,
and the compile panel lists every diagnostic, the cost estimate and the
acknowledgements the graph needs.

### Start from something

- **Duplicate** a built-in (or any template) to get an editable copy in
  **Yours**. A duplicate of a built-in runs on the graph runtime. Duplicating
  a project template copies it at the digest you see.
- **New graph** opens a blank, unsaved draft.
- **Describe a graph** lets you write what the graph should do and pick a
  model. An agent drafts it in the background (you can switch away; the job
  carries on) and the draft opens in the designer **unsaved**. Check it, then
  save it. Tick "Modify the current draft" to have it change the draft you are
  editing instead.
- **Import JSON…** takes a template you paste or pick as a file; **Import
  bundle…** takes a share bundle (see [Sharing](#share-bundles)).

### Edit on the canvas

Click **Edit** (or **Edit as JSON**) on one of your templates. Every change is
one undoable step: **Ctrl/Cmd+Z** undoes, **Shift+Ctrl/Cmd+Z** or **Ctrl+Y**
redoes (outside text fields), up to 100 steps. **Ctrl/Cmd+S** saves.

- **Add nodes** from the palette on the canvas: Agent, System (pick the action;
  actions with side effects are marked), Gate, Merge, Human, Loop region (wraps
  the selected node), Sub-graph (one of your saved templates) and, for
  isolated branches, Select branch.
- **Connect** by dragging from an output handle to an input. While you drag,
  compatible inputs light up and the rest dim; a hint says what the drop will
  do or why it is refused. Handle colours show the type family. Dropping on a
  node's `+` handle adds a new input of the right type.
- **Fan-in.** Drawing a replicated node (one branch per reviewer, say) into a
  single input inserts a de-duplicating merge for you when the results are
  item lists (findings, issues); otherwise the input becomes a list that
  collects every branch. You can undo the insertion.
- **Loops.** Drop a node onto a loop frame to move it in; drag it off to take
  it out. An edge that would close a cycle inside a loop becomes a *carry*
  (the value goes to the next iteration). Set the loop's bound and its
  `until` condition in the inspector.
- **Move** nodes freely; **Arrange** lays the graph out for you.
- **Delete** with Delete or Backspace, or the inspector's Delete. Edges and
  references that pointed at the node are cleaned up.
- **Keyboard.** Arrow keys move between nodes, Enter selects, **C** opens
  "Connect to…", **L** opens "Loop…", **Shift+arrows** move a node.

Leaving unsaved changes asks first. A new draft that was never saved is lost
on reload. If someone else saved the same template while you were editing,
**Save** offers **Save as copy** or **Reload latest**.

### Configure a node

Select a node to edit it in the inspector. An agent node has four tabs:

- **Prompt.** Type `{{` for what the node can read: `> input.<port>` inserts an
  input as an evidence block, `input.<port>.<field>` a field, plus
  `params.*`, `run.iteration`, `lens.*`, `branch.*` and `ticket.*`. The
  preview renders the prompt the agent will get from each input type's
  example (or a fixture you paste), followed by the **system contract**: the
  locked part Orkestrator adds (the output tools to call, what the node may
  do, untrusted-content rules). You cannot edit or remove the contract. The
  size meter warns when the prompt approaches its ceiling.
- **Inputs/Outputs.** Port names and types, how an input is rendered, how a
  list input collects branches, the choices of a decision output.
- **Capabilities.** The profile (Observer, Reviewer, Verifier, Researcher,
  Builder or Custom), workspace access, extra allows and denies, Orkestrator
  tool groups, your MCP servers (Off, Grant or Deny each), the minimum
  enforcement tier and the per-provider matrix. A node can never do more than
  the environment allows or than the project's capability ceiling allows, and
  no agent node can push or write to GitHub: system nodes do that.
- **Execution.** The role (which model runs it), replication (a panel of
  models, lenses, samples, or one branch per item of a list input), session
  (fresh or continue an earlier node's), whether it may ask you a question
  (`ask_human`), retries, timeout, what happens on failure, and a `when`
  condition.

System nodes take their action's parameters in a typed form. Gates take
branches with conditions (built with the condition editor, with path
suggestions from the input types). Merges take a strategy: concat, dedupe (by
a key), vote (majority over decisions), best (by a score) or collect. Human nodes take a form: approve, edit (you may change a value
before approving) or choose (one of several options), and an optional
timeout.

### Types

Results are typed. The library has built-in types (ticket, review report,
workspace, decision, ...). For your own, open **Custom types** in the
template form: build the schema with the form (or as JSON, or **Schema from
example**). Schemas are limited to a subset every provider accepts; the
editor checks it as you type. Renaming a type updates every port that uses
it.

### Sub-graphs

Add a **Sub-graph** node to use another saved template as one step. Pin it to
the version you tested (**Pin current version**) so later edits to the child
do not change this graph; **Update ports from template** picks up a new
version on purpose. Bind each child parameter to a value or one of your
parameters, and each child role to one of yours. The built-in Multi Review
works as a sub-graph and then runs on the graph runtime.

### Compile results and acknowledgements

The compile panel updates as you edit. You can save a graph with errors, but
it cannot launch until they are fixed; warnings do not block a launch. Two kinds of warning need an explicit
**Acknowledge** before the graph can launch: untrusted content (for example
a review of a pull request) reaching a side effect, and a node whose
minimum enforcement tier you lowered. Changing what the warning is about
asks again. The cost estimate shows the best and worst number of agent
sessions and the peak parallelism.

## Testing with mock runs

**Mock run** in the designer header runs the saved template (an unsaved draft
is saved first) on the real scheduler with canned answers: no provider
sessions, no tokens, no pushes, no pull requests, no ticket changes. Agents
answer with their output types' examples (or values generated from the
schema), system nodes record what they *would have done*, and human nodes
approve by themselves. The run view opens and steps through the graph about
once a second.

To test a particular path, pin answers. Select a node and open its **Mock
run** tab (agents) or section (system and human nodes) and list what each
activation returns, in order: the example, a generated value, custom JSON, a
failure with a cause, or for a human node another outlet or **pause** (wait
for you). The last entry repeats. For example, pin a verifier's verdict as
fail, fail, pass to see a fix loop converge on the third iteration. Pins are
saved with the template but are not part of its digest.

Built-ins must be duplicated before they can be mock run.

## Launching

A run always launches from a **saved** template. Project templates must be
approved first, and a graph with compile errors or unacknowledged warnings
cannot launch.

- **Run graph…** in the environment action bar, or **Run** in the designer
  header, opens the launch dialog. It is generated from the template: pick a
  model per role (only providers that meet each step's enforcement floor are
  offered; the others say why not), panel members and their focus (lens),
  parameters, inputs (a ticket input takes a Kanban ticket; workspace inputs
  come from the environment), and where to run: this environment, a new
  worktree or a new container. The cost estimate follows your choices. Your
  choices are saved as this template's defaults for the project.
- **Run graph…** on a Kanban card launches with that ticket as the graph's
  ticket input and links the ticket to the run's environment.
- **The CLI**: `orkestrator graph list`, `show`, `validate`, `launch`,
  `status` and `cancel` ([public-cli.md](public-cli.md#graphs)).
- **The coordinator** can list templates, launch one, read a run and cancel
  it. It cannot create or edit templates. It is told when a run waits for a
  person and when it ends.
- **Schedules**: a schedule can launch a saved graph at a set time
  ([scheduled-jobs.md](scheduled-jobs.md)). In Settings → Schedules choose
  **New schedule**, then the action **Run a graph**: pick the project, a
  template that can be launched, where each run works and its inputs. Leave
  **Use the saved launch defaults** on to give each run the roles and
  parameters last saved for the template (Run graph… saves them), or turn it
  off to pin them in the schedule. From the CLI: `orkestrator schedule create
  --cron "0 2 * * *" --graph user:<id> --project <id> --new-worktree`, with
  the same `--role`, `--param` and `--input` flags as `graph launch`. A
  coordinator schedules its own `launch_graph` instead.

## Watching a run

After a launch the run opens in its own **Graph run** tab. You can also open
any run from the runs list under the designer's library. The run carries on
in the backend whether or not the tab is open: closing the tab, switching
environments or reloading never stops it, and the view catches up from the
stored run when you come back.

- **The flow.** Each step is a node; loop iterations unroll to the right and
  replicated steps show one node per branch (per item for an items fan-out).
  Steps not reached yet are faded; branches a gate did not take are shown as
  skipped.
- **The inspector.** Select a node for its status, errors, the enforcement
  tier that actually applied, guard results, tokens and times, progress
  items, and its input and output artifacts rendered by type. **Transcript**
  shows the agent's conversation; **Open session** opens it in a tab.
- **Controls.** Pause, Resume and Cancel the run; Retry a failed step; Skip a
  step that is waiting; restart or rewind (below).

### When a run needs you

A run asks for you in two ways: a **human node** (approve, edit or choose)
and an agent's **question** (`ask_human`, when the node allows it). Either
way the node reads "waiting for you", the run header shows a banner, and the
environment's unread badge lights in the sidebar. Answer in the inspector:
pick Approve/Reject or an option, optionally add a note, and for an edit form
change the value (the form checks it against its type). An agent question
can also be declined. A human node without a timeout waits indefinitely;
with one, a timeout takes the node's failure route.

## Restarting and rewinding

- **Retry** a failed step: it runs again as a new attempt.
- **Restart from here** reruns a step and everything that depends on it.
  Independent branches keep their results; the superseded attempts stay
  visible as "Previous attempt" nodes.
- **Rewind code to here…** also resets the run's branch to the commit the step
  started from. Pause the run first. A preview shows what will be dropped,
  and you confirm against the commit it showed. If the rewind dropped commits
  that were already pushed, the next push of the branch forces with lease.

Restarted agent steps start a fresh session.

## Sharing and trusting templates

### Project templates

Commit a template to `.orkestrator/graphs/<name>.graph.json` and everyone who
opens the project sees it under **Project**, untrusted. **Review (N)** in the
designer header lists untrusted and changed project templates with a summary
of what each may do (agent profiles, extra capabilities, nodes that write
the workspace, system actions with side effects, untrusted-content paths)
and, for a changed one, a diff against the copy you last approved.
**Approve** trusts exactly the digest you reviewed; **Reject** keeps it
untrusted until the file changes again. Any change to the file makes it
*changed* and unlaunchable until you approve again. **Revoke trust** undoes
an approval.

The project's **capability ceiling** caps every template compiled for that
project, whoever wrote it.

### Share bundles

**Share…** exports a template as a bundle file (`<id>.graph-bundle.json`)
with its custom types and two digests, optionally signed with this
installation's key. **Import bundle…** shows a preview first: whether the
bundle is intact, who signed it (unsigned, an unknown key with its
fingerprint, or a key you trust), the digest, the compile result and a
capability summary. A tampered bundle is refused. Anything else imports as
one of your templates only when you confirm with **Import at this digest**.
You can trust a colleague's key from the preview (**Trust key**).

## Limits worth knowing

- At most 32 branches per replicated node, 8 for isolated branch worktrees.
- Loops always have a bound.
- A template's limits hold at run time: at most `maxAgentSessions` agent
  sessions, `maxConcurrentAgents` at once, and, when set, a token budget
  (`maxTokens`: once reached, agents already running finish but no new one
  starts) and a wall-clock limit (`maxWallClockMs`: the run fails and its
  running steps stop once it has run that long, paused time included). The
  run's header shows usage against them.
- Results are checked against their type when the agent submits them; an
  agent gets a few chances to correct a refused result.
- Agent nodes never push or write to GitHub; put a Push branch or Open pull
  request system node after them.
- What a profile promises is enforced by the provider where it can be, and
  otherwise checked by a guard after the step (the inspector says which).
  See the per-provider matrix in the Capabilities tab.
