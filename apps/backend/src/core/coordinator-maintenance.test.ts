import { expect, mock, test } from "bun:test";
import { runCoordinatorMaintenance } from "./coordinator-maintenance.js";

test("an unresolved PR read cannot block later coordinator repairs", () => {
  const repair = mock(() => {});
  const poll = mock(() => new Promise<void>(() => {}));
  const error = mock(() => {});
  runCoordinatorMaintenance(repair, poll, error);
  runCoordinatorMaintenance(repair, poll, error);
  expect(repair).toHaveBeenCalledTimes(2);
  expect(error).not.toHaveBeenCalled();
});

test("poll failures are handled independently", async () => {
  const failure = new Error("offline");
  const repair = mock(() => {});
  const error = mock(() => {});
  runCoordinatorMaintenance(repair, () => Promise.reject(failure), error);
  await Promise.resolve();
  expect(repair).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith(failure);
});
