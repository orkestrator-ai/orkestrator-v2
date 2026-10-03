import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { SortableEnvironmentItem } from "./SortableEnvironmentItem";
import type { Environment } from "@/types";

afterEach(cleanup);

const environment = (id: string, projectHome = false) =>
  ({
    id,
    projectId: "project-1",
    name: id,
    projectHome,
    branch: "feature/x",
    status: "running",
    environmentType: "local",
    order: 0,
    networkAccessMode: "full",
    createdAt: "2026-10-01T00:00:00Z",
  }) as Environment;

const renderItem = (env: Environment) =>
  render(
    <DndContext>
      <SortableContext items={[env.id]}>
        <SortableEnvironmentItem
          environment={env}
          isSelected={false}
          onSelect={() => {}}
          onDelete={() => {}}
          onStart={() => {}}
          onStop={() => {}}
          onRestart={() => {}}
        />
      </SortableContext>
    </DndContext>,
  );

test("project home reserves the drag handle width so it aligns with other environments", () => {
  renderItem(environment("home", true));
  const spacer = screen.getByTestId("project-home-handle-spacer");
  expect(spacer.className).toContain("w-4");
  expect(spacer.className).toContain("shrink-0");
  expect(spacer.getAttribute("aria-hidden")).toBe("true");
  expect(screen.queryByRole("button", { name: "" })).toBeNull();
});

test("regular environments render the drag handle instead of a spacer", () => {
  renderItem(environment("worker"));
  expect(screen.queryByTestId("project-home-handle-spacer")).toBeNull();
  expect(screen.getByRole("button", { name: "" }).getAttribute("aria-roledescription")).toBe(
    "sortable",
  );
});
