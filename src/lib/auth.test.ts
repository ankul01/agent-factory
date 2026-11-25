import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionToken,
  verifyAdminCredentials,
  verifySessionToken,
} from "./auth";
import { safeEqual } from "./crypto";

const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("safeEqual handles equal, mismatched lengths without RangeError, and empty values", () => {
  assert.equal(safeEqual("secret-token", "secret-token"), true);
  assert.equal(safeEqual("short", "much-longer-string"), false);
  assert.equal(safeEqual("", ""), false);
  assert.equal(safeEqual("   ", "   "), false);
  assert.equal(safeEqual(null, "abc"), false);
  assert.equal(safeEqual("abc", undefined), false);
});

test("createSessionToken & verifySessionToken accept valid tokens and reject expired/tampered ones", () => {
  const now = 1_700_000_000_000;
  const token = createSessionToken("ankul", TEST_SECRET, now);

  const valid = verifySessionToken(token, TEST_SECRET, now + 1000);
  assert.deepEqual(valid?.sub, "ankul");

  // Expired
  const expired = verifySessionToken(token, TEST_SECRET, now + 1000 * 60 * 60 * 24 * 8);
  assert.equal(expired, null);

  // Tampered payload
  const [payloadPart, sigPart] = token.split(".");
  const tamperedPayload = Buffer.from(
    JSON.stringify({ sub: "attacker", exp: now + 999999999 }),
    "utf8",
  ).toString("base64url");
  assert.equal(verifySessionToken(`${tamperedPayload}.${sigPart}`, TEST_SECRET, now), null);

  // Tampered signature (different length)
  assert.equal(verifySessionToken(`${payloadPart}.deadbeef`, TEST_SECRET, now), null);

  // Wrong secret or missing secret
  assert.equal(verifySessionToken(token, "wrong-secret", now), null);
  assert.equal(verifySessionToken(token, "", now), null);
});

test("verifyAdminCredentials validates against env vars and rejects empty env", () => {
  const prevUser = process.env.ADMIN_USERNAME;
  const prevPass = process.env.ADMIN_PASSWORD;

  try {
    process.env.ADMIN_USERNAME = "ankul";
    process.env.ADMIN_PASSWORD = "super-strong-password";

    assert.equal(verifyAdminCredentials("ankul", "super-strong-password"), true);
    assert.equal(verifyAdminCredentials("ankul", "wrong"), false);
    assert.equal(verifyAdminCredentials("other", "super-strong-password"), false);

    process.env.ADMIN_PASSWORD = "";
    assert.equal(verifyAdminCredentials("ankul", ""), false);
  } finally {
    process.env.ADMIN_USERNAME = prevUser;
    process.env.ADMIN_PASSWORD = prevPass;
  }
});
