import { describe, expect, test } from "bun:test";
import * as projects from "@/components/projects";

describe("projects component exports", () => {
  test("exposes every public project component through the barrel", () => {
    expect(projects.ProjectItem).toBeTypeOf("function");
    expect(projects.AddProjectDialog).toBeTypeOf("function");
    expect(projects.ProjectLauncher).toBeTypeOf("function");
  });
});
