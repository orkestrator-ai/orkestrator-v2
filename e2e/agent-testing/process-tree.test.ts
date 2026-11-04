import { expect, test } from "bun:test";
import { processTree } from "./process-tree";

test("includes worker-thread children and descendants exactly once", () => {
  const tasks: Record<number, string[]> = { 1: ["1", "2"], 3: ["3"], 4: ["4"] };
  const children: Record<string, string> = { "1/1": "", "1/2": "3 4", "3/3": "4", "4/4": "" };
  expect(
    processTree(
      1,
      (pid) => tasks[pid]!,
      (pid, tid) => children[`${pid}/${tid}`]!,
    ),
  ).toEqual([1, 3, 4]);
});

test("an exiting thread does not hide surviving siblings' children", () => {
  expect(
    processTree(
      1,
      (pid) => {
        if (pid === 3) throw new Error("exited");
        return ["1", "2"];
      },
      (_pid, tid) => {
        if (tid === "1") throw new Error("exited");
        return "3";
      },
    ),
  ).toEqual([1, 3]);
});
