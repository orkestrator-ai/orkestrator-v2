import { expect, test } from "bun:test";
import {
  coordinatorDefersToCommandNode,
  projectLandingBoardTab,
  projectLandingTab,
  windowGroupingFor,
} from "./window-grouping";

test("another node's coordinator defers to the command node only when grouped by repository", () => {
  expect(coordinatorDefersToCommandNode("repository")).toBe(true);
  expect(coordinatorDefersToCommandNode("machine")).toBe(false);
  expect(coordinatorDefersToCommandNode("project")).toBe(false);
  expect(coordinatorDefersToCommandNode("activity")).toBe(false);
});

test("a sidebar project entry lands on Home only for another node's project grouped by repository", () => {
  const expected = {
    repository: { command: "coordinator", leaf: "home" },
    machine: { command: "coordinator", leaf: "coordinator" },
    project: { command: "coordinator", leaf: "coordinator" },
    activity: { command: "coordinator", leaf: "coordinator" },
  } as const;
  for (const grouping of ["repository", "machine", "project", "activity"] as const) {
    for (const node of ["command", "leaf"] as const) {
      const onCommandNode = node === "command";
      const tab = expected[grouping][node];
      expect({ grouping, node, tab: projectLandingTab(grouping, onCommandNode) }).toEqual({
        grouping,
        node,
        tab,
      });
      // Home is where another node's workspace opens a project anyway, so it is not asked for.
      expect(projectLandingBoardTab(grouping, onCommandNode)).toBe(
        tab === "coordinator" ? "coordinator" : undefined,
      );
    }
  }
});

test("compact counts as repository grouping", () => {
  expect(windowGroupingFor("project", "compact")).toBe("repository");
  // Compact lists no environments, so sorting them changes nothing about it.
  expect(windowGroupingFor("activity", "compact")).toBe("repository");
  expect(windowGroupingFor("project", "machine")).toBe("machine");
  expect(windowGroupingFor("activity", "repository")).toBe("activity");
});

test("the phone layout's grouping follows the full list for both stored compact sort modes", () => {
  expect(windowGroupingFor("project", "compact", true)).toBe("repository");
  expect(windowGroupingFor("activity", "compact", true)).toBe("activity");
  expect(windowGroupingFor("activity", "compact", false)).toBe("repository");
});
