import { expect, test } from "bun:test";
import { findProjectHomeEnvironment, withoutProjectHomes } from "./project-home";
import type { Environment } from "@/types";

const environment = (overrides: Partial<Environment>) =>
  ({ id: "env", projectId: "project-1", ...overrides }) as Environment;

test("finds the live home of the requested project", () => {
  const environments = [
    environment({ id: "worker" }),
    environment({ id: "deleting-home", projectHome: true, deletionRequestedAt: "2026-10-10" }),
    environment({ id: "lifecycle-home", projectHome: true, lifecycleOperation: "deleting" }),
    environment({ id: "other-home", projectId: "project-2", projectHome: true }),
    environment({ id: "home", projectHome: true }),
  ];

  expect(findProjectHomeEnvironment(environments, "project-1")?.id).toBe("home");
  expect(findProjectHomeEnvironment(environments, "project-3")).toBeUndefined();
});

test("drops project homes from the sidebar's environment rows", () => {
  const environments = [
    environment({ id: "worker-a" }),
    environment({ id: "home", projectHome: true }),
    environment({ id: "worker-b" }),
  ];

  expect(withoutProjectHomes(environments).map((entry) => entry.id)).toEqual([
    "worker-a",
    "worker-b",
  ]);
});
