import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { decodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import { PublicActionError } from "./errors.js";

/** Strict, content-free input validation for public actions. */

export function invalid(message: string): PublicActionError {
  return new PublicActionError("invalid-input", message);
}

export function onlyKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw invalid(`Unknown input field: ${key.slice(0, 64)}`);
  }
}

export function requiredString(
  input: Record<string, unknown>,
  key: string,
  max: number = PUBLIC_API_LIMITS.idMaxChars,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) throw invalid(`${key} is required`);
  if (value.length > max) {
    throw new PublicActionError("input-too-large", `${key} must be at most ${max} characters`);
  }
  return value;
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
  max: number = PUBLIC_API_LIMITS.idMaxChars,
): string | undefined {
  if (input[key] === undefined) return undefined;
  return requiredString(input, key, max);
}

export function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalid(`${key} must be a boolean`);
  return value;
}

export function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function oneOf<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalid(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function requiredOneOf<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = oneOf(input, key, allowed);
  if (value === undefined) throw invalid(`${key} is required`);
  return value;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function requiredId(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key);
  if (!ID_PATTERN.test(value)) throw invalid(`${key} is not a valid ID`);
  return value;
}

export function sessionTarget(input: Record<string, unknown>): {
  sessionId: string;
  environmentId: string;
  tabId: string;
} {
  const sessionId = requiredString(input, "sessionId", 700);
  const decoded = decodePublicSessionId(sessionId);
  if (!decoded)
    throw new PublicActionError("not-found", "Session ID is not a valid session handle");
  return { sessionId, ...decoded };
}

export function absolutePath(input: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(input, key, PUBLIC_API_LIMITS.pathMaxChars);
  if (value === undefined) return undefined;
  if (!value.startsWith("/") || value.includes("\0")) {
    throw invalid(`${key} must be an absolute path on the backend host`);
  }
  return value;
}

export function textInput(
  input: Record<string, unknown>,
  key: string,
  maxChars: number,
  maxBytes: number,
): string {
  const value = input[key];
  if (typeof value !== "string") throw invalid(`${key} is required`);
  if (value.trim().length === 0) throw new PublicActionError("empty-input", `${key} is empty`);
  if (value.length > maxChars || Buffer.byteLength(value) > maxBytes) {
    throw new PublicActionError("input-too-large", `${key} is too large`);
  }
  return value;
}
