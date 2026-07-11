export const GATEWAY_TOKEN_MIN_LENGTH = 16;
export const GATEWAY_TOKEN_MAX_LENGTH = 1024;
export const GATEWAY_COOKIE_MAX_BYTES = 4096;

const AUTH_COOKIE = "orkestrator_gateway_auth";
const COOKIE_ATTRIBUTES = "HttpOnly; SameSite=Strict; Path=/";
const textEncoder = new TextEncoder();

export class GatewayTokenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayTokenValidationError";
  }
}

function encodedToken(value: string): string | null {
  try {
    return encodeURIComponent(value);
  } catch {
    return null;
  }
}

export function getGatewayTokenValidationError(value: string): string | null {
  const token = value.trim();
  if (token.length < GATEWAY_TOKEN_MIN_LENGTH) {
    return `Gateway token must be at least ${GATEWAY_TOKEN_MIN_LENGTH} characters.`;
  }
  if (token.length > GATEWAY_TOKEN_MAX_LENGTH) {
    return `Gateway token must be ${GATEWAY_TOKEN_MAX_LENGTH} characters or fewer.`;
  }

  const encoded = encodedToken(token);
  if (encoded === null) {
    return "Gateway token contains invalid Unicode characters.";
  }

  const cookie = `${AUTH_COOKIE}=${encoded}; ${COOKIE_ATTRIBUTES}`;
  if (textEncoder.encode(cookie).byteLength > GATEWAY_COOKIE_MAX_BYTES) {
    return "Gateway token is too large to store in a browser cookie.";
  }
  return null;
}

export function normalizeGatewayToken(value: string): string {
  const token = value.trim();
  const error = getGatewayTokenValidationError(token);
  if (error) throw new GatewayTokenValidationError(error);
  return token;
}

export function gatewayTokenCookieHeader(value: string): string {
  const token = normalizeGatewayToken(value);
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; ${COOKIE_ATTRIBUTES}`;
}
