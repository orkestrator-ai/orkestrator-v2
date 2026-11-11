/**
 * `coordinator` commands for the Actions panel's manual marks
 * (`@orkestrator/protocol/coordinator-action-marks`): action cards the user
 * marked done by hand in one coordinator conversation. Registered from
 * `commands-registry-client-state.ts`, beside the other presentation state
 * every client shares.
 *
 * Both are `workspace` commands: a window showing another node's coordinator
 * reads and writes that node's marks. Ids are checked by the handler with its
 * own messages, so the argument schemas only name the keys.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { mutableArray } from "../../model-schema.js";
import { coordinatorDomain } from "./domain.js";

/** `CoordinatorActionMarks` (`coordinator-action-marks.ts`): one conversation's marked card ids. */
export const CoordinatorActionMarksSchema = Schema.Struct({
  projectId: Schema.String,
  conversationId: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cardIds: mutableArray(Schema.String),
});

/** A conversation's manual marks; revision 0 and no ids while none are stored. */
export const getCoordinatorActionMarksCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_coordinator_action_marks",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
    conversationId: Schema.String,
  }),
  result: CoordinatorActionMarksSchema,
  critical: [],
});

/**
 * Marks one card done (`done: true`) or clears its manual mark (`done:
 * false`). Idempotent: a mark already in force changes nothing and keeps the
 * revision. Answers the conversation's marks after the change.
 */
export const setCoordinatorActionMarkCommand = defineCommand({
  domain: coordinatorDomain,
  name: "set_coordinator_action_mark",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    conversationId: Schema.String,
    cardId: Schema.String,
    done: Schema.Boolean,
  }),
  result: CoordinatorActionMarksSchema,
  critical: [],
});

/** The action-mark part of `COORDINATOR_COMMANDS`. */
export const COORDINATOR_ACTION_MARK_COMMANDS = [
  getCoordinatorActionMarksCommand,
  setCoordinatorActionMarkCommand,
] as const;
