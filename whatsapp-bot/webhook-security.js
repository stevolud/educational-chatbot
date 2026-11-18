import { createHmac, timingSafeEqual } from "node:crypto";

export function isValidSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== "string" || !secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const receivedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

export function isDuplicateMessage(id, processedMessages, now = Date.now()) {
  const retention = 24 * 60 * 60 * 1000;
  for (const [messageId, timestamp] of processedMessages) {
    if (now - timestamp > retention) processedMessages.delete(messageId);
  }
  if (processedMessages.has(id)) return true;
  processedMessages.set(id, now);
  while (processedMessages.size > 5000) {
    const oldest = processedMessages.keys().next().value;
    if (oldest === undefined) break;
    processedMessages.delete(oldest);
  }
  return false;
}
