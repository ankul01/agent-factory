import { cookies } from "next/headers";
import { computeHmacSha256Hex, safeEqual } from "./crypto";

export const SESSION_COOKIE_NAME = "af_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  sub: string;
  exp: number;
}

/**
 * Creates a signed stateless session token: <base64url(payload)>.<hmacSha256Hex>.
 */
export function createSessionToken(
  username: string,
  secret: string,
  nowMs: number = Date.now(),
): string {
  if (!secret || secret.trim() === "") {
    throw new Error("SESSION_SECRET must not be empty.");
  }
  if (!username || username.trim() === "") {
    throw new Error("Username must not be empty.");
  }

  const payload: SessionPayload = {
    sub: username,
    exp: nowMs + SESSION_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = computeHmacSha256Hex(encoded, secret);
  return `${encoded}.${signature}`;
}

/**
 * Verifies a signed session token's HMAC signature and expiration timestamp.
 */
export function verifySessionToken(
  token: string | undefined | null,
  secret: string | undefined | null,
  nowMs: number = Date.now(),
): SessionPayload | null {
  if (!token || !secret || token.trim() === "" || secret.trim() === "") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [encoded, providedSig] = parts;
  if (!encoded || !providedSig) {
    return null;
  }

  const expectedSig = computeHmacSha256Hex(encoded, secret);
  if (!safeEqual(providedSig, expectedSig)) {
    return null;
  }

  try {
    const raw = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("sub" in parsed) ||
      !("exp" in parsed)
    ) {
      return null;
    }
    const candidate = parsed as { sub: unknown; exp: unknown };
    if (
      typeof candidate.sub !== "string" ||
      candidate.sub.trim() === "" ||
      typeof candidate.exp !== "number" ||
      !Number.isFinite(candidate.exp) ||
      candidate.exp <= nowMs
    ) {
      return null;
    }
    return { sub: candidate.sub, exp: candidate.exp };
  } catch {
    return null;
  }
}

/**
 * Verifies admin username and password against environment variables in constant time.
 */
export function verifyAdminCredentials(username: string, password: string): boolean {
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;
  const userOk = safeEqual(username, expectedUser);
  const passOk = safeEqual(password, expectedPass);
  return userOk && passOk;
}

/**
 * Reads and validates the af_session cookie from Next.js request cookies.
 */
export async function requireAdminSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(token, process.env.SESSION_SECRET);
}

export function getSessionCookieOptions() {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}
