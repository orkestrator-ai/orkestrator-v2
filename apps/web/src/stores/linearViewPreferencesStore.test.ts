import { beforeEach, describe, expect, test } from "bun:test";
import { appCommandStore } from "@/test/app-command-store";
import { linearViewPreferencesStore, MAX_LINEAR_VIEW_PROJECTS } from "./linearViewPreferencesStore";

const store = () => appCommandStore(linearViewPreferencesStore);

describe("linearViewPreferencesStore", () => {
  beforeEach(() => store().setState({ projects: {} }));

  test("remembers each project's view and hidden lanes", () => {
    store().getState().setView("p1", "board");
    store().getState().setLaneHidden("p1", "Backlog", true);
    store().getState().setLaneHidden("p1", "Done", true);
    store().getState().setLaneHidden("p1", "Backlog", false);
    expect(store().getState().projects.p1).toMatchObject({
      view: "board",
      hiddenLanes: ["Done"],
    });
    expect(store().getState().projects.p2).toBeUndefined();

    store().getState().showAllLanes("p1");
    expect(store().getState().projects.p1?.hiddenLanes).toEqual([]);
  });

  test("keeps at most the most recently changed projects", () => {
    for (let index = 0; index < MAX_LINEAR_VIEW_PROJECTS + 5; index += 1) {
      store().getState().setView(`p${index}`, "board");
    }
    expect(Object.keys(store().getState().projects)).toHaveLength(MAX_LINEAR_VIEW_PROJECTS);
  });
});
