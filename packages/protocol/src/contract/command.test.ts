import { describe, expect, it } from "bun:test";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  InvalidCommandArgsError,
  InvalidCommandResultError,
  buildInvokeEnvelope,
  decodeCommandArgs,
  decodeCommandResult,
  defineCommand,
  isCommandDef,
  validateCommandResult,
  type ArgsOf,
  type ArgKeyOf,
  type EncodedArgsOf,
  type ResultOf,
} from "./command.js";
import { defineDomain } from "./domain.js";
import { UnsupportedFieldError, incompatibility } from "./errors.js";

const nodeMail = defineDomain({ name: "node-mail", version: 2, min: 1 });

const Recipient = Schema.Struct({ nodeId: Schema.String, mailbox: Schema.String });

const deliverNodeMail = defineCommand({
  domain: nodeMail,
  name: "deliver_node_mail",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    to: Recipient,
    subject: Schema.String.check(Schema.isMaxLength(200)),
    steer: Schema.optionalKey(Schema.Boolean),
    priority: Schema.optionalKey(Schema.Finite),
  }),
  result: Schema.Struct({ id: Schema.String, queued: Schema.Boolean }),
  critical: ["steer"],
});

const readTranscript = defineCommand({
  domain: nodeMail,
  name: "get_transcript_page",
  since: 2,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: Schema.Struct({ rows: Schema.Array(Schema.String) }),
  critical: [],
  encoded: true,
});

// Type-level pins: a mismatch fails `bun check`.
type Assert<T extends true> = T;
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type ArgsPin = Assert<
  Equals<
    ArgsOf<typeof deliverNodeMail>,
    {
      readonly to: { readonly nodeId: string; readonly mailbox: string };
      readonly subject: string;
      readonly steer?: boolean;
      readonly priority?: number;
    }
  >
>;
export type ResultPin = Assert<
  Equals<ResultOf<typeof deliverNodeMail>, { readonly id: string; readonly queued: boolean }>
>;
export type EncodedPin = Assert<
  Equals<EncodedArgsOf<typeof deliverNodeMail>, ArgsOf<typeof deliverNodeMail>>
>;
export type KeyPin = Assert<
  Equals<ArgKeyOf<typeof deliverNodeMail.args>, "to" | "subject" | "steer" | "priority">
>;

const validArgs = { to: { nodeId: "n1", mailbox: "inbox" }, subject: "hi" };

describe("defineCommand", () => {
  it("returns a frozen definition with defaults", () => {
    expect(isCommandDef(deliverNodeMail)).toBe(true);
    expect(Object.isFrozen(deliverNodeMail)).toBe(true);
    expect(Object.isFrozen(deliverNodeMail.critical)).toBe(true);
    expect(deliverNodeMail.encoded).toBe(false);
    expect(readTranscript.encoded).toBe(true);
    expect(deliverNodeMail.domain).toBe(nodeMail);
    expect(isCommandDef({ kind: "event" })).toBe(false);
  });

  it("refuses invalid names, since, access and critical lists", () => {
    const base = {
      domain: nodeMail,
      name: "ok_name",
      since: 1,
      access: "workspace" as const,
      read: true,
      args: Schema.Struct({ a: Schema.String }),
      result: Schema.Null,
      critical: [] as "a"[],
    };
    expect(() => defineCommand(base)).not.toThrow();
    for (const name of ["Bad", "bad-name", "", "1bad", "b".repeat(129)]) {
      expect(() => defineCommand({ ...base, name })).toThrow(/command name/);
    }
    for (const since of [0, 3, 1.5]) {
      expect(() => defineCommand({ ...base, since })).toThrow(/since/);
    }
    expect(() => defineCommand({ ...base, access: "public" as "admin" })).toThrow(/access/);
    expect(() => defineCommand({ ...base, critical: ["b" as "a"] })).toThrow(/not an argument key/);
    // @ts-expect-error critical names only declared argument keys.
    expect(() => defineCommand({ ...base, critical: ["b"] })).toThrow(/not an argument key/);
  });

  it("exports its schemas as JSON Schema for the manifest digests", () => {
    const document = Schema.toJsonSchemaDocument(deliverNodeMail.args);
    expect(document.dialect).toBe("draft-2020-12");
    expect(JSON.stringify(document.schema)).toContain('"required":["to","subject"]');
    expect(() => Schema.toJsonSchemaDocument(deliverNodeMail.result)).not.toThrow();
  });
});

describe("decodeCommandArgs", () => {
  it("strips unknown keys (tolerant reader)", () => {
    const result = decodeCommandArgs(deliverNodeMail, {
      ...validArgs,
      futureOption: "x",
      to: { ...validArgs.to, extra: 1 },
    });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success).toEqual(validArgs);
  });

  it("refuses an unknown critical field the arguments carry, with code and field", () => {
    const result = decodeCommandArgs(
      deliverNodeMail,
      { ...validArgs, idempotencyKey: "k1" },
      { critical: ["idempotencyKey"] },
    );
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    const error = result.failure;
    expect(error).toBeInstanceOf(UnsupportedFieldError);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof UnsupportedFieldError)) return;
    expect(error.code).toBe("unsupported-field");
    expect(error.field).toBe("idempotencyKey");
    expect(error.domain).toBe("node-mail");
    expect(error.message).not.toContain("k1");
    expect(incompatibility(error)).toEqual({
      code: "unsupported-field",
      domain: "node-mail",
      field: "idempotencyKey",
      command: "deliver_node_mail",
    });
  });

  it("accepts a known critical field and ignores a listed one that is absent", () => {
    const known = decodeCommandArgs(
      deliverNodeMail,
      { ...validArgs, steer: true },
      { critical: ["steer"] },
    );
    expect(Result.isSuccess(known) && known.success.steer).toBe(true);
    const absent = decodeCommandArgs(deliverNodeMail, validArgs, {
      critical: ["idempotencyKey"],
    });
    expect(Result.isSuccess(absent)).toBe(true);
  });

  it("fails a schema mismatch with InvalidCommandArgsError", () => {
    const result = decodeCommandArgs(deliverNodeMail, { to: validArgs.to, subject: 7 });
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure).toBeInstanceOf(InvalidCommandArgsError);
    expect(result.failure.message).toContain("deliver_node_mail");
    expect(incompatibility(result.failure)).toBeNull();
  });

  it("decodes absent arguments as an empty object", () => {
    expect(Result.isSuccess(decodeCommandArgs(readTranscript, undefined))).toBe(true);
    expect(Result.isFailure(decodeCommandArgs(deliverNodeMail, undefined))).toBe(true);
  });
});

describe("results", () => {
  it("validates a result and returns its wire form", () => {
    const ok = validateCommandResult(deliverNodeMail, { id: "m1", queued: true, extra: 1 });
    expect(Result.isSuccess(ok)).toBe(true);
    const bad = validateCommandResult(deliverNodeMail, { id: "m1" });
    expect(Result.isFailure(bad)).toBe(true);
    if (Result.isFailure(bad)) expect(bad.failure).toBeInstanceOf(InvalidCommandResultError);
  });

  it("skips validation for pre-encoded results", () => {
    const spliced: unknown = { rows: [1, 2] };
    const result = validateCommandResult(readTranscript, spliced);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success as unknown).toBe(spliced);
  });

  it("decodes a received result tolerantly", () => {
    const result = decodeCommandResult(deliverNodeMail, { id: "m1", queued: false, newer: 1 });
    expect(Result.isSuccess(result) && result.success).toEqual({ id: "m1", queued: false });
    expect(Result.isFailure(decodeCommandResult(deliverNodeMail, null))).toBe(true);
  });
});

describe("buildInvokeEnvelope", () => {
  it("lists only the critical keys the arguments carry", () => {
    expect(buildInvokeEnvelope(deliverNodeMail, validArgs)).toEqual({
      command: "deliver_node_mail",
      args: validArgs,
      domain: "node-mail",
      version: 2,
    });
    expect(buildInvokeEnvelope(deliverNodeMail, { ...validArgs, steer: false }, 1)).toEqual({
      command: "deliver_node_mail",
      args: { ...validArgs, steer: false },
      domain: "node-mail",
      version: 1,
      critical: ["steer"],
    });
  });
});
