import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import AdmZip from "adm-zip";
import initSqlJs from "sql.js";
import { resolve } from "node:path";
import { createApp, splitMessage } from "./server.js";
import { parseApkg, parseCsv } from "./study-files.js";

async function createTestServer(t, options = {}) {
  const server = createApp(options).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function signedHeaders(body, secret) {
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return {
    "content-type": "application/json",
    "x-hub-signature-256": `sha256=${signature}`,
  };
}

test("verifies Meta webhook subscription challenge tokens", async (t) => {
  const baseUrl = await createTestServer(t, {
    env: { VERIFY_TOKEN: "test-verify-token", META_APP_SECRET: "test-secret" },
  });
  const accepted = await fetch(
    `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=challenge-value`,
  );
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), "challenge-value");

  const rejected = await fetch(
    `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-value`,
  );
  assert.equal(rejected.status, 403);
});

test("rejects unsigned webhooks and processes a valid message only once", async (t) => {
  const secret = "test-secret";
  const processed = [];
  let resolveProcessed;
  const delivered = new Promise((resolve) => { resolveProcessed = resolve; });
  const baseUrl = await createTestServer(t, {
    env: { VERIFY_TOKEN: "test-verify-token", META_APP_SECRET: secret },
    onMessage: async (message) => {
      processed.push(message.id);
      resolveProcessed();
    },
  });
  const body = JSON.stringify({
    entry: [{
      changes: [{
        value: { messages: [{ id: "wamid-test-1", from: "15551234567", type: "text", text: { body: "hello" } }] },
      }],
    }],
  });

  const unsigned = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(unsigned.status, 401);
  assert.deepEqual(processed, []);

  const accepted = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: signedHeaders(body, secret),
    body,
  });
  assert.equal(accepted.status, 200);
  await delivered;
  assert.deepEqual(processed, ["wamid-test-1"]);

  const duplicate = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: signedHeaders(body, secret),
    body,
  });
  assert.equal(duplicate.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(processed, ["wamid-test-1"]);
});

test("parses CSV question, answer, and extra columns", () => {
  assert.deepEqual(
    parseCsv("\uFEFFquestion,answer,extra\r\nWhat is ATP?,Energy carrier,Made by cells"),
    [{ front: "What is ATP?", back: "Energy carrier", extra: "Made by cells" }],
  );
  assert.throws(() => parseCsv('question,answer\n"unfinished,answer'), /never closed/);
});

test("splits long WhatsApp replies without dropping text or dividing a surrogate pair", () => {
  const body = `A`.repeat(3998) + "😀" + "tail\n" + "B".repeat(300);
  const parts = splitMessage(body);

  assert.ok(parts.every((part) => part.length <= 4000));
  assert.equal(parts.join(""), body);
  assert.ok(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part)));
});

function protoField(fieldNumber, text) {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([(fieldNumber << 3) | 2, bytes.length]), bytes]);
}

async function createModernApkg() {
  const SQL = await initSqlJs({
    locateFile: (filename) => resolve("node_modules/sql.js/dist", filename),
  });
  const database = new SQL.Database();
  try {
    database.run("CREATE TABLE notetypes (id INTEGER)");
    database.run("CREATE TABLE fields (ntid INTEGER, ord INTEGER, name TEXT)");
    database.run("CREATE TABLE templates (ntid INTEGER, ord INTEGER, config BLOB)");
    database.run("CREATE TABLE notes (id INTEGER, mid INTEGER, flds TEXT)");
    database.run("CREATE TABLE cards (id INTEGER, nid INTEGER, ord INTEGER)");
    database.run("INSERT INTO notetypes VALUES (1)");
    database.run("INSERT INTO fields VALUES (1, 0, 'Question'), (1, 1, 'Answer'), (1, 2, 'Extra')");
    database.run(
      "INSERT INTO templates VALUES (1, 0, ?)",
      [Buffer.concat([protoField(1, "{{Question}}"), protoField(2, "{{FrontSide}}<hr>{{Answer}}")])],
    );
    database.run("INSERT INTO notes VALUES (100, 1, 'What is ATP?\u001fEnergy carrier\u001fMade by cells')");
    database.run("INSERT INTO cards VALUES (200, 100, 0)");

    const archive = new AdmZip();
    archive.addFile("collection.anki21", Buffer.from(database.export()));
    return archive.toBuffer();
  } finally {
    database.close();
  }
}

test("imports modern Anki templates and keeps unused note fields as extra notes", async () => {
  const cards = await parseApkg(await createModernApkg());
  assert.deepEqual(cards, [{
    front: "What is ATP?",
    back: "What is ATP? Energy carrier",
    extra: "Made by cells",
  }]);
});
