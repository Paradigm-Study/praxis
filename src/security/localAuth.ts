import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export function validateLocalToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("PRAXIS_LOCAL_TOKEN must contain at least 32 bytes");
  }
  return token;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function constantTimeTokenEqual(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  return timingSafeEqual(digest(expected), digest(actual));
}

export function bearerToken(req: IncomingMessage, header = "authorization"): string | undefined {
  const value = req.headers[header];
  const text = Array.isArray(value) ? value[0] : value;
  const match = text?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1];
}

export function authorizeLocalRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expected: string | undefined,
  header = "authorization",
): boolean {
  if (!expected) return true; // developer backward compatibility
  if (constantTimeTokenEqual(expected, bearerToken(req, header))) return true;
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": "Bearer realm=\"praxis-local\"",
  });
  res.end(JSON.stringify({ error: "unauthorized" }));
  return false;
}
