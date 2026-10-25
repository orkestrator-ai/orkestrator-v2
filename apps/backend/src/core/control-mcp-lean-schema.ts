import { fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";

/**
 * Small hand-written input schemas for the voice core and gateway tools.
 *
 * The voice profile's whole `tools/list` must fit in 8,000 bytes, and a Zod
 * schema publishes `$schema` plus every bound. These tools only shape a call
 * into a public action, whose handler validates every value authoritatively,
 * so their schemas name the fields, types, enums and required set and leave
 * length limits to the handler. Built once per process, because the MCP
 * server is rebuilt for every request.
 */

type Property = Record<string, unknown>;

export function text(description?: string): Property {
  return { type: "string", ...(description ? { description } : {}) };
}

export function integer(minimum: number, maximum?: number, description?: string): Property {
  return {
    type: "integer",
    minimum,
    ...(maximum !== undefined ? { maximum } : {}),
    ...(description ? { description } : {}),
  };
}

export function oneOf(values: readonly string[], description?: string): Property {
  return { type: "string", enum: values, ...(description ? { description } : {}) };
}

export function leanSchema<T>(properties: Record<string, Property>, required: string[] = []) {
  return fromJsonSchema<T>({
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  } as JsonSchemaType);
}
