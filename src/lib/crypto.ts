import crypto from "node:crypto";

/**
 * Constant-time string comparison via SHA-256 digesting.
 * Rejects empty/whitespace-only inputs and never throws RangeError on length mismatch.
 */
export function safeEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b || a.trim() === "" || b.trim() === "") {
    return false;
  }

  const digestA = crypto.createHash("sha256").update(a, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Computes a lowercase hex HMAC-SHA256 digest for the given payload and secret.
 */
export function computeHmacSha256Hex(payload: string, secret: string): string {
  if (!secret || secret.trim() === "") {
    throw new Error("HMAC secret must be a non-empty string.");
  }
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}
