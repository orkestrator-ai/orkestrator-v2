/**
 * The `public-api` domain (plan item 7009): `public_action` is defined, and
 * stays as lenient as its handler was, so the dispatcher still answers every
 * malformed wrapper with its own structured envelope.
 */
import { describe, expect, it } from "bun:test";
import { isNodeReadCommand } from "../../../command-nodes.js";
import { PUBLIC_ACTION_COMMAND, publicErrorEnvelope } from "../../../public-api.js";
import { decodeCommandArgs, validateCommandResult } from "../../command.js";
import { incompatibility } from "../../errors.js";
import { PUBLIC_API_COMMANDS, publicActionCommand } from "./index.js";

const WRAPPER_KEYS = [
  "schemaVersion",
  "action",
  "actionVersion",
  "input",
  "request",
  "node",
  "relayedAuthority",
];

describe("public_action definition", () => {
  it("is the protocol's public command, version 1 of public-api, admin and not a read", () => {
    expect(PUBLIC_API_COMMANDS).toEqual([publicActionCommand]);
    expect(publicActionCommand.name).toBe(PUBLIC_ACTION_COMMAND);
    expect(publicActionCommand.domain).toMatchObject({ name: "public-api", version: 1, min: 1 });
    expect(publicActionCommand.since).toBe(1);
    expect(publicActionCommand.access).toBe("admin");
    expect(publicActionCommand.read).toBe(isNodeReadCommand(PUBLIC_ACTION_COMMAND));
    expect(publicActionCommand.critical).toEqual(["node", "relayedAuthority"]);
  });

  it("declares every wrapper key the dispatcher reads, each of any type", () => {
    expect(Object.keys(publicActionCommand.args.fields).sort()).toEqual([...WRAPPER_KEYS].sort());
    const odd = Object.fromEntries(WRAPPER_KEYS.map((key) => [key, 42]));
    const decoded = decodeCommandArgs(publicActionCommand, odd);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).toEqual(odd);
    expect(decodeCommandArgs(publicActionCommand, {})._tag).toBe("Success");
  });

  it("drops an unknown wrapper key, and refuses one the sender marked critical", () => {
    const request = { schemaVersion: 1, action: "capabilities", actionVersion: 1, input: {} };
    const decoded = decodeCommandArgs(publicActionCommand, { ...request, fromANewerCli: true });
    expect(decoded._tag === "Success" && decoded.success).toEqual(request);
    const refused = decodeCommandArgs(
      publicActionCommand,
      { ...request, deadline: 5 },
      { critical: ["deadline"] },
    );
    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure") {
      expect(incompatibility(refused.failure, PUBLIC_ACTION_COMMAND)).toMatchObject({
        code: "unsupported-field",
        field: "deadline",
      });
    }
  });

  it("validates both envelopes and keeps their payloads", () => {
    const success = {
      schemaVersion: 1,
      action: "capabilities",
      ok: true,
      result: { anything: [1, 2] },
      backend: { installationId: "i", generation: "g" },
    };
    const validated = validateCommandResult(publicActionCommand, success);
    expect(validated._tag).toBe("Success");
    const failure = publicErrorEnvelope("session.start", {
      code: "invalid-input",
      message: "input must be an object",
    });
    expect(validateCommandResult(publicActionCommand, failure)._tag).toBe("Success");
    expect(validateCommandResult(publicActionCommand, { ok: true })._tag).toBe("Failure");
  });
});
