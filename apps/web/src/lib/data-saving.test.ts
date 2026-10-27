import { afterEach, describe, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { startDataSavingReadPolicy } from "./data-saving";
import { resetReadCoordinatorForTests } from "./read-coordinator";
import { installFakeReadCoordinator } from "./testing/read-coordinator";

afterEach(() => resetReadCoordinatorForTests());

describe("data-saving read policy", () => {
  test("applies the stored preference at once and every change after", () => {
    const store = createStore<{ dataSaving: boolean }>(() => ({ dataSaving: true }));
    const applied: boolean[] = [];
    const stop = startDataSavingReadPolicy(store, (enabled) => applied.push(enabled));
    expect(applied).toEqual([true]);
    store.setState({ dataSaving: true });
    store.setState({ dataSaving: false });
    expect(applied).toEqual([true, false]);
    stop();
    store.setState({ dataSaving: true });
    expect(applied).toEqual([true, false]);
  });

  test("drives the shared coordinator by default", () => {
    const { coordinator } = installFakeReadCoordinator();
    const store = createStore<{ dataSaving: boolean }>(() => ({ dataSaving: false }));
    const stop = startDataSavingReadPolicy(store);
    expect(coordinator.getDiagnostics().dataSaving).toBe(false);
    store.setState({ dataSaving: true });
    expect(coordinator.getDiagnostics().dataSaving).toBe(true);
    stop();
  });
});
