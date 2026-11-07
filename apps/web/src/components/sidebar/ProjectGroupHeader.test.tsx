import { afterEach, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { ComponentProps } from "react";
import { Collapsible } from "@/components/ui/collapsible";
import { RepositoryMemberContext } from "@/contexts/RepositoryMemberContext";
import { ProjectGroupHeader } from "./ProjectGroupHeader";

afterEach(cleanup);

const noop = () => {};

function Header({
  member,
  ...props
}: Partial<ComponentProps<typeof ProjectGroupHeader>> & { member?: boolean }) {
  const header = (
    <ProjectGroupHeader
      projectName="Checkout"
      accessibleLabel="Open Checkout"
      label="This computer"
      card={{ environmentCount: 0, runningCount: 0, openHint: "Open project" }}
      unreadMail={0}
      failedMail={false}
      highlighted={false}
      ariaCurrent={undefined}
      sortable={false}
      isCollapsed={false}
      onOpen={noop}
      menu={{
        openBoard: noop,
        openSettings: noop,
        newEnvironment: noop,
        deleteProject: noop,
      }}
      writable
      newEnvironment={{ label: "New environment", title: "New environment" }}
      {...props}
    />
  );
  return (
    <Collapsible open>
      {member === undefined ? (
        header
      ) : (
        <RepositoryMemberContext value={member}>{header}</RepositoryMemberContext>
      )}
    </Collapsible>
  );
}

test.each([undefined, false, true])(
  "header reserves repository geometry only when membership is true (%s)",
  (member) => {
    renderInAppCommandScope(<Header member={member} icon={<span data-testid="project-icon" />} />);
    const button = screen.getByRole("button", { name: "Open Checkout" });
    const activity = screen.getByTestId("coordinator-activity-icon");
    expect(button.classList.contains("pl-[39px]")).toBe(member === true);
    if (member) {
      expect(button.classList.contains("relative")).toBe(true);
      const slot = activity.parentElement!;
      expect(slot.parentElement).toBe(button);
      for (const name of ["absolute", "inset-y-0", "left-2", "w-8", "justify-center"]) {
        expect(slot.classList.contains(name)).toBe(true);
      }
    } else {
      // Outside repository groups the activity wrapper stays in the button's flow.
      expect(activity.parentElement).toBe(button);
      expect(button.classList.contains("px-2")).toBe(true);
    }
  },
);

test.each([false, true])(
  "iconless label retains its layout through coordinator transitions (member %s)",
  (member) => {
    const view = renderInAppCommandScope(<Header member={member} />);
    const button = screen.getByRole("button", { name: "Open Checkout" });
    const label = screen.getByText("This computer");
    const initialClasses = button.className;
    expect(button.classList.contains("pl-[39px]")).toBe(member);
    expect(screen.queryByTestId("coordinator-activity-icon") === null).toBe(true);

    for (const state of ["working", "waiting", null] as const) {
      view.rerender(<Header member={member} coordinatorActivity={state} />);
      expect(button.className).toBe(initialClasses);
      expect(screen.getByText("This computer")).toBe(label);
      if (state) {
        const activity = screen.getByTestId("coordinator-activity-icon");
        expect(activity.getAttribute("data-state")).toBe(state);
        expect(activity.parentElement === button).toBe(!member);
        if (member) {
          expect(activity.parentElement!.classList.contains("absolute")).toBe(true);
          expect(activity.parentElement!.classList.contains("w-8")).toBe(true);
        }
      } else {
        expect(screen.queryByTestId("coordinator-activity-icon") === null).toBe(true);
      }
    }
  },
);
