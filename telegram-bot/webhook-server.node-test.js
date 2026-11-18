import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramWebhookServer,
  createTelegramWebhookUrl,
} from "./webhook-server.js";

const SECRET = "a".repeat(32);

async function withServer(options, run) {
  const server = createTelegramWebhookServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendUpdate(url, body, secret = SECRET) {
  return fetch(`${url}/telegram-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body,
  });
}

test("builds the Telegram HTTPS webhook URL from Render's hostname", () => {
  assert.equal(
    createTelegramWebhookUrl("stevolud-bot.onrender.com"),
    "https://stevolud-bot.onrender.com/telegram-webhook",
  );
  assert.throws(() => createTelegramWebhookUrl("https://example.com/path"), /valid public hostname/);
});

test("serves a health check and rejects webhook requests without the secret", async () => {
  let handled = 0;
  await withServer({ handleUpdate: async () => handled++, secretToken: SECRET }, async (url) => {
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const unauthorized = await sendUpdate(url, JSON.stringify({ update_id: 1 }), "wrong-secret");
    assert.equal(unauthorized.status, 401);
    assert.equal(handled, 0);
  });
});

test("processes authorized updates once and returns success for Telegram retries", async () => {
  const handled = [];
  await withServer({
    handleUpdate: async (update) => handled.push(update.update_id),
    secretToken: SECRET,
  }, async (url) => {
    const body = JSON.stringify({ update_id: 5, message: { text: "/start" } });
    assert.equal((await sendUpdate(url, body)).status, 200);
    assert.equal((await sendUpdate(url, body)).status, 200);
    assert.deepEqual(handled, [5]);
  });
});

test("rejects malformed, unauthorized-shape, and oversized webhook payloads", async () => {
  await withServer({
    handleUpdate: async () => {},
    secretToken: SECRET,
    maxBodyBytes: 16,
  }, async (url) => {
    assert.equal((await sendUpdate(url, "{")).status, 400);
    assert.equal((await sendUpdate(url, JSON.stringify([]))).status, 400);
    assert.equal((await sendUpdate(url, JSON.stringify({ update_id: 123456789 }))).status, 413);
  });
});

test("returns a retryable error when update processing fails", async () => {
  let attempts = 0;
  await withServer({
    handleUpdate: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
    },
    secretToken: SECRET,
    logger: { error() {} },
  }, async (url) => {
    const body = JSON.stringify({ update_id: 9 });
    assert.equal((await sendUpdate(url, body)).status, 500);
    assert.equal((await sendUpdate(url, body)).status, 200);
    assert.equal(attempts, 2);
  });
});
