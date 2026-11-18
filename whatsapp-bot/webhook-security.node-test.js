import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { isDuplicateMessage, isValidSignature } from "./webhook-security.js";

test("validates Meta signatures against each original webhook request body", () => {
  const body = Buffer.from('{"entry":[]}');
  const secret = "local-test-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  assert.equal(isValidSignature(body, signature, secret), true);
  assert.equal(isValidSignature(body, signature, "wrong-secret"), false);
  assert.equal(isValidSignature(Buffer.from("{}"), signature, secret), false);
  assert.equal(isValidSignature(body, "invalid", secret), false);
  assert.equal(isValidSignature(body, signature, ""), false);
});

test("deduplicates message IDs and expires old webhook deliveries", () => {
  const seen = new Map();
  assert.equal(isDuplicateMessage("wamid-1", seen, 1000), false);
  assert.equal(isDuplicateMessage("wamid-1", seen, 2000), true);
  assert.equal(isDuplicateMessage("wamid-1", seen, 1000 + 24 * 60 * 60 * 1000 + 1), false);
});
