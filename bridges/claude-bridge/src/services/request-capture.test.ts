import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RequestCapture } from "./request-capture.js";
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "request-capture-test-"));
  directories.push(dir);
  return new RequestCapture(dir);
}
test("capture is opt in, survives recreation, and never exports bodies to inherited collectors", async () => {
  const capture = await fixture();
  expect(await capture.enabled()).toBe(false);
  expect(
    (await capture.environment({ OTEL_LOG_RAW_API_BODIES: "1" })).OTEL_LOG_RAW_API_BODIES,
  ).toBeUndefined();
  await capture.setEnabled(true);
  expect(await new RequestCapture(capture.directory).enabled()).toBe(true);
  const env = await capture.environment({ PATH: "test", OTEL_LOGS_EXPORTER: "otlp" });
  expect(env.PATH).toBe("test");
  expect(env.OTEL_LOG_RAW_API_BODIES).toBe(`file:${capture.directory}`);
  expect(env.OTEL_LOGS_EXPORTER).toBe("none");
  expect((await stat(capture.directory)).mode & 0o777).toBe(0o700);
  await capture.setEnabled(false);
  expect(await capture.enabled()).toBe(false);
});
test("history retains unanswered requests, links responses, and rejects paths and symlinks", async () => {
  const capture = await fixture();
  await writeFile(
    path.join(capture.directory, "attempt.request.json"),
    '{"system":"fixture instructions","tools":[]}',
  );
  await writeFile(path.join(capture.directory, "req_test.response.json"), '{"id":"msg_test"}');
  await writeFile(
    path.join(capture.directory, "index.jsonl"),
    JSON.stringify({
      request_file: "attempt.request.json",
      response_file: "req_test.response.json",
      request_id: "req_test",
      message_id: "msg_test",
    }) + "\n{incomplete",
  );
  const files = await capture.list();
  expect(files).toHaveLength(2);
  expect((await capture.index())["attempt.request.json"]).toMatchObject({
    requestId: "req_test",
    pairedFile: "req_test.response.json",
  });
  expect(await capture.detail("attempt.request.json")).toContain("fixture instructions");
  await expect(capture.detail("../enabled")).rejects.toThrow();
  await symlink(
    path.join(capture.directory, "attempt.request.json"),
    path.join(capture.directory, "link.request.json"),
  );
  await expect(capture.detail("link.request.json")).rejects.toThrow();
});
test("retention bounds count and individual file size without removing unrelated files", async () => {
  const capture = await fixture();
  await writeFile(path.join(capture.directory, "unrelated"), "keep");
  await writeFile(
    path.join(capture.directory, "large.request.json"),
    Buffer.alloc(16 * 1024 * 1024 + 1),
  );
  for (let i = 0; i < 205; i++)
    await writeFile(path.join(capture.directory, `${i}.request.json`), "{}");
  expect(await capture.list()).toHaveLength(200);
  await expect(stat(path.join(capture.directory, "large.request.json"))).rejects.toThrow();
  expect((await stat(path.join(capture.directory, "unrelated"))).size).toBe(4);
});
