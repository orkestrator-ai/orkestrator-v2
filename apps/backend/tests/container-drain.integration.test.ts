import { expect, test } from "bun:test";
import path from "node:path";

test.skipIf(process.platform !== "linux")(
  "drain signal ordering, EOF flushing, stopped jobs and survivors",
  async () => {
    const child = Bun.spawn(
      ["python3", path.resolve(import.meta.dir, "../../../docker/tests/drain-regression.py")],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ status, output: status === 0 ? "" : stdout + stderr }).toEqual({
      status: 0,
      output: "",
    });
  },
  30_000,
);
