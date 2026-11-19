/**
 * The `capabilities` domain: reads are classified as the router classifies
 * them, executor commands are internal, fleet mutations are admin, the
 * decode keeps every declared key and drops the rest, and results keep
 * undeclared fields.
 */
import { describe, expect, it } from "bun:test";
import * as Result from "effect/Result";

import { isNodeReadCommand } from "../../../command-nodes.js";
import { decodeCommandArgs, decodeCommandResult } from "../../command.js";
import {
  applyCapabilityNodeEnvironmentPlanCommand,
  applyCapabilityNodePlanCommand,
  CAPABILITIES_COMMANDS,
  capabilitiesClient,
  getCapabilityNodeEnvironmentObservationCommand,
  getCapabilityNodeObservationCommand,
  inspectCapabilitySourceCommand,
  listCapabilityPackagesCommand,
  previewCapabilityChangeCommand,
  verifyAgentCapabilityCommand,
} from "./index.js";
import { CAPABILITIES_EVENTS } from "./events.js";

describe("capabilities domain", () => {
  it("classifies every command as the node router does", () => {
    for (const command of CAPABILITIES_COMMANDS) {
      expect(command.read, command.name).toBe(isNodeReadCommand(command.name));
      expect(command.critical).toEqual([]);
    }
  });

  it("keeps the executor internal and the fleet mutations admin", () => {
    for (const command of CAPABILITIES_COMMANDS) {
      if (command.name.includes("_capability_node_"))
        expect(command.access, command.name).toBe("internal");
    }
    expect(inspectCapabilitySourceCommand.access).toBe("admin");
    expect(previewCapabilityChangeCommand.access).toBe("admin");
    expect(listCapabilityPackagesCommand.access).toBe("workspace");
    expect(verifyAgentCapabilityCommand.access).toBe("workspace");
    expect(getCapabilityNodeObservationCommand.read).toBe(true);
    expect(applyCapabilityNodePlanCommand.read).toBe(false);
    expect(getCapabilityNodeEnvironmentObservationCommand.read).toBe(true);
    expect(applyCapabilityNodeEnvironmentPlanCommand.read).toBe(false);
  });

  it("decodes tolerantly: declared keys kept, unknown keys dropped", () => {
    const decoded = decodeCommandArgs(previewCapabilityChangeCommand, {
      change: { kind: "add-to-setup", inspectionId: "insp_1" },
      requestKey: "k",
      destination: "/etc",
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success).toEqual({
        change: { kind: "add-to-setup", inspectionId: "insp_1" },
        requestKey: "k",
      });
    }
  });

  it("keeps undeclared result fields", () => {
    const decoded = decodeCommandResult(listCapabilityPackagesCommand, {
      revision: 3,
      packages: [{ id: "p", future: true }],
      truncated: 0,
      epoch: 1,
      newer: "kept",
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded))
      expect((decoded.success as unknown as Record<string, unknown>).newer).toBe("kept");
  });

  it("has a current and a legacy adapter, and content-free events", () => {
    expect(capabilitiesClient.versions).toEqual([1, 0]);
    expect(CAPABILITIES_EVENTS.map((event) => event.name)).toEqual([
      "capability-management-changed",
      // `node-` so a command node's event stream from its leaf carries it.
      "node-capability-launch-requested",
    ]);
  });
});
