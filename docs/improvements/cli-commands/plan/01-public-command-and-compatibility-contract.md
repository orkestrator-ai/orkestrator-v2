# 01 — Define the public command and compatibility contract

Status: Planned.
Depends on: None.
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

Every supported command has a precise target, request shape, response shape,
capability requirement, and exit behavior. CLI, backend, and tests share that
contract. Existing gateway/desktop command consumers retain their responses.

## Owners and starting points

- [Protocol package](../../../../packages/protocol/src): public types, runtime
  validators, capability and receipt definitions; proposed new control modules.
- [Gateway invoke handler](../../../../apps/backend/src/gateway-handlers.ts).
- [Command registration](../../../../apps/backend/src/core/commands-registry.ts).
- [Native-agent contract](../../../../packages/protocol/src/native-agent.ts).
- [Existing CLI package](../../../../packages/cli/package.json).

## Work

1. Inventory every command listed in the source review. Classify it as a direct
   adapter, shared-action extraction, or new backend contract. For each, record
   whether it changes metadata, filesystem, external repository, provider
   session, or process state, and whether completion can be observed today.
2. Define public summaries for connections, projects, environments, sessions,
   operations, and interactions. IDs must be opaque and stable; expose useful
   environment/tab IDs without requiring callers to manufacture logical-session
   keys. Define allowed names and rejection of ambiguous matches.
3. Define a capabilities action with a public schema version, backend identity,
   supported action versions, input/output limits, and provider-dependent
   observation/control capabilities. An available transport is not proof that
   a specific action or completion mode is supported.
4. Define one JSON envelope with schema version, command/action, safe connection
   identity, and either result or structured error. Include a request/run receipt
   whenever admission may have occurred. Fix where error envelopes go: JSON
   mode writes exactly one envelope to stdout; human diagnostics go to stderr.
   ID mode prints only its documented ID on success and nothing to stdout on
   failure. Human mode is allowed to evolve independently.
5. Set stable error codes and the exit mapping: 0 success for the requested
   condition, 1 operation failure, 2 invalid input, 3 absent/ambiguous target,
   4 connection/auth failure, 5 observer deadline, 6 interaction required,
   7 unknown dispatch, 8 conflict/unsupported capability. Preserve more precise
   JSON codes within those classes. Document signal exits separately.
6. Separate operation admission, provider dispatch, execution, and observation
   fields. Define which operations support `--wait`, which condition is checked,
   and how partial creation is represented. A successful HTTP response carrying
   rejection must produce a nonzero CLI exit.
7. Define mutually exclusive prompt/patch input sources, byte and character
   limits, absolute backend-path rules, pagination, unset/inherit semantics,
   and explicit defaults. Text encoding and empty-input behavior must be clear.
8. Keep the generic legacy `{result}`/`{error}` gateway wrapper compatible.
   Public action results can carry their typed envelope within it. Add structured
   errors for those actions without reclassifying every legacy exception.
   Never infer an error category by matching its English message.
9. Decide the release subset and capability names before adding parser branches.
   Capture representative success, rejection, unknown, partial, waiting, and
   expired-result examples as protocol fixtures. Do not expose raw storage data
   or a generic stable interface to every internal registry command.

## Verification

Use protocol validation tests for valid/invalid envelopes, unknown fields where
strictness matters, size boundaries, contradictory states, and unknown schema
versions. Add old-client/new-backend and new-client/old-backend fixtures at the
gateway adapter boundary. Verify unsupported mutation capability causes zero
mutation requests and HTTP 200 plus rejected dispatch is not CLI success.

## Acceptance and handoff

- [ ] A command matrix maps each public action to its backend owner and milestone.
- [ ] JSON examples, exit codes, IDs, limits, and compatibility policy are fixed.
- [ ] Receipt fields can express unknown and partial outcomes without losing IDs.
- [ ] Public summaries exclude prompt/credential-bearing storage fields.
- [ ] Steps 02–05 can implement the contract without inventing different shapes.

Ship contracts with their first consumers rather than introducing a large unused
framework. Keep new capabilities unavailable until their implementation is
ready; reverting a consumer must not make old clients reinterpret an action.
