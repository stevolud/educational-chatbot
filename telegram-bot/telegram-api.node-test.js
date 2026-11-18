import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramApi,
  formatTelegramHtml,
  splitTelegramText,
} from "./telegram-api.js";

test("escapes untrusted study content while retaining bold reply labels", () => {
  assert.equal(
    formatTelegramHtml("*Answer:* <script>alert('hi')</script> & context"),
    "<b>Answer:</b> &lt;script&gt;alert('hi')&lt;/script&gt; &amp; context",
  );
});

test("splits long messages without losing text or cutting a surrogate pair", () => {
  const text = `${"x".repeat(749)}😀more\n${"y".repeat(800)}`;
  const parts = splitTelegramText(text);
  assert.ok(parts.every((part) => part.length <= 750));
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part)));
});

test("sends Telegram text with the bot token and escaped HTML", async () => {
  const requests = [];
  const api = createTelegramApi("123:test-token", async (url, options) => {
    requests.push({ url, options });
    return Response.json({ ok: true, result: { message_id: requests.length } });
  });
  await api.sendMessage(42, "*Question:* What is <ATP>?");

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/bot123:test-token\/sendMessage$/);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    chat_id: 42,
    text: "<b>Question:</b> What is &lt;ATP&gt;?",
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
});

test("gets updates with a signal and downloads only valid Telegram file paths", async () => {
  const requests = [];
  const api = createTelegramApi("123:test-token", async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/getUpdates")) return Response.json({ ok: true, result: [] });
    if (url.endsWith("/getFile")) {
      return Response.json({ ok: true, result: { file_path: "documents/study file.csv", file_size: 3 } });
    }
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const controller = new AbortController();
  await api.getUpdates(4, 12, controller.signal);
  const file = await api.getFile("file-id");
  const bytes = await api.downloadFile(file.file_path, 10);

  assert.deepEqual(JSON.parse(requests[0].options.body), {
    offset: 4,
    timeout: 12,
    allowed_updates: ["message"],
  });
  assert.equal(requests[0].options.signal.aborted, false);
  assert.match(requests[2].url, /\/file\/bot123:test-token\/documents\/study%20file\.csv$/);
  assert.deepEqual([...bytes], [1, 2, 3]);
  await assert.rejects(api.downloadFile("../secret.csv", 10), /unsupported file path/);
});

test("rejects files that exceed the streaming download limit", async () => {
  const api = createTelegramApi("123:test-token", async () => new Response(new Uint8Array(20)));
  await assert.rejects(api.downloadFile("docs/large.csv", 10), /over the 20 MB/);
});
