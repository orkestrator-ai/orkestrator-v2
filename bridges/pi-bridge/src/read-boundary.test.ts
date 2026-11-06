import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { COORDINATOR_PROTECTED_DATA_DIR_ENV } from "@orkestrator/protocol/coordinator";
import type { ReadBoundary } from "@orkestrator/protocol/node/coordinator-read-boundary";
import {
  PI_READ_BOUNDARY_REFUSAL,
  piCoordinatorReadBoundary,
  piReadToolRefused,
} from "./read-boundary.js";

const { requestToolApproval } = await import("./interactions.js");
const { newSessionState } = await import("./agent-session.js");

let root: string;
let dataDir: string;
let checkout: string;
let attachments: string;
let boundary: ReadBoundary;
const previous = process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-read-boundary-")));
  dataDir = join(root, "data dir");
  checkout = join(root, "checkout");
  attachments = join(dataDir, "coordinator-attachments", "c1", "v1");
  mkdirSync(attachments, { recursive: true });
  mkdirSync(join(dataDir, "agent-accounts", "pi"), { recursive: true });
  mkdirSync(checkout);
  writeFileSync(join(dataDir, "control-mcp.json"), "{}");
  writeFileSync(join(attachments, "pasted.txt"), "pasted");
  symlinkSync(join(dataDir, "control-mcp.json"), join(checkout, "innocent.json"));
  symlinkSync(dataDir, join(checkout, "linked-dir"));
  boundary = piCoordinatorReadBoundary(checkout, {
    [COORDINATOR_PROTECTED_DATA_DIR_ENV]: dataDir,
    ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT: attachments,
  })!;
});

afterEach(() => {
  if (previous === undefined) delete process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV];
  else process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV] = previous;
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const refused = (tool: string, input: unknown) =>
  piReadToolRefused(boundary, tool, input, checkout);

describe("Pi's coordinator read boundary", () => {
  test("is absent outside a coordinator process", () => {
    expect(piCoordinatorReadBoundary(checkout, {})).toBeNull();
    expect(piCoordinatorReadBoundary(checkout, { [COORDINATOR_PROTECTED_DATA_DIR_ENV]: "x" })).toBe(
      null,
    );
  });

  test("refuses read and ls on the data directory, however the path is spelled", () => {
    const credentials = join(dataDir, "control-mcp.json");
    expect(refused("read", { path: credentials })).toBe(true);
    expect(refused("read", { path: `@${credentials}` })).toBe(true);
    expect(refused("read", { path: pathToFileURL(credentials).href })).toBe(true);
    expect(refused("read", { path: credentials.replace("data dir", "data dir") })).toBe(true);
    expect(refused("read", { path: "innocent.json" })).toBe(true);
    expect(refused("read", { path: "linked-dir/agent-accounts/pi/auth.json" })).toBe(true);
    expect(refused("ls", { path: dataDir })).toBe(true);
    expect(refused("ls", { path: "linked-dir" })).toBe(true);
  });

  test("refuses a search rooted in, at a link to, or above the data directory", () => {
    expect(refused("grep", { pattern: "token", path: dataDir })).toBe(true);
    expect(refused("grep", { pattern: "token", path: "linked-dir" })).toBe(true);
    // Pi's grep passes --hidden, so a search of an ancestor reaches the directory.
    expect(refused("grep", { pattern: "token", path: root })).toBe(true);
    expect(refused("find", { pattern: "*.json", path: root })).toBe(true);
  });

  test("leaves the checkout and this conversation's attachments readable", () => {
    expect(refused("read", { path: "README.md" })).toBe(false);
    expect(refused("read", { path: join(attachments, "pasted.txt") })).toBe(false);
    expect(refused("grep", { pattern: "x" })).toBe(false);
    expect(refused("find", { pattern: "*.ts" })).toBe(false);
    // Listing an ancestor shows names, not contents.
    expect(refused("ls", { path: root })).toBe(false);
  });

  test("judges only Pi's reading tools", () => {
    expect(refused("bash", { command: `cat ${dataDir}/control-mcp.json` })).toBe(false);
    expect(refused("read", {})).toBe(false);
  });
});

describe("the approval gate", () => {
  test("refuses a coordinator's read of the data directory, whatever the approval policy", async () => {
    process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV] = dataDir;
    const state = newSessionState();
    expect(
      await requestToolApproval(state, "call-1", "read", {
        path: join(dataDir, "control-mcp.json"),
      }),
    ).toEqual({ block: true, reason: PI_READ_BOUNDARY_REFUSAL });
    expect(await requestToolApproval(state, "call-2", "read", { path: "package.json" })).toEqual({
      block: false,
    });
    expect(state.approvals.size).toBe(0);
  });

  test("checks nothing in a bridge the launcher named no directory for", async () => {
    delete process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV];
    const state = newSessionState();
    expect(
      await requestToolApproval(state, "call-1", "read", {
        path: join(dataDir, "control-mcp.json"),
      }),
    ).toEqual({ block: false });
  });
});
