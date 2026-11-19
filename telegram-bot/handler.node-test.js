import assert from "node:assert/strict";
import test from "node:test";
import { createStudyBot } from "../whatsapp-bot/conversation.js";
import { createMemoryFileCatalog } from "./file-catalog.js";
import { createTelegramUpdateHandler } from "./handler.js";

function createHarness() {
  const sent = [];
  const gradeCalls = [];
  const fileCalls = [];
  const fileCatalog = createMemoryFileCatalog();
  const api = {
    sendMessage: async (chatId, text) => sent.push({ chatId, text }),
    getFile: async (fileId) => {
      fileCalls.push(["getFile", fileId]);
      return { file_path: "documents/study.csv", file_size: 30 };
    },
    downloadFile: async (filePath, limit) => {
      fileCalls.push(["downloadFile", filePath, limit]);
      return Buffer.from("question,answer,extra\nWhat is ATP?,Energy carrier,Cell fuel");
    },
  };
  const studyBot = createStudyBot({
    sendText: async (chatId, text) => api.sendMessage(Number(chatId), text),
    gradeAnswer: async (card, answer) => {
      gradeCalls.push({ card, answer });
      return "Good effort.";
    },
  });
  const handleUpdate = createTelegramUpdateHandler({
    api,
    studyBot,
    fileCatalog,
    parseStudyFile: async (buffer, filename) => {
      if (filename !== "biology.csv") {
        throw new Error("Send an .apkg, .pdf, .xlsx, .csv, .docx or .doc file.");
      }
      assert.equal(buffer.toString(), "question,answer,extra\nWhat is ATP?,Energy carrier,Cell fuel");
      return {
        cards: [{ front: "What is ATP?", back: "Energy carrier", extra: "Cell fuel" }],
      };
    },
    generateCards: async () => {
      throw new Error("Card generation should not be called for imported cards.");
    },
    maxFileBytes: 20 * 1024 * 1024,
    logger: { error() {} },
  });
  return { handleUpdate, sent, gradeCalls, fileCalls, fileCatalog };
}

function privateDocumentUpdate(fileSize = 30) {
  return {
    update_id: 1,
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345, is_bot: false },
      document: { file_id: "file-1", file_name: "biology.csv", file_size: fileSize },
    },
  };
}

test("downloads a study file, sends a question, waits for the reply, then reveals answer and extra", async () => {
  const { handleUpdate, sent, gradeCalls, fileCalls } = createHarness();
  await handleUpdate(privateDocumentUpdate());

  assert.deepEqual(fileCalls, [
    ["getFile", "file-1"],
    ["downloadFile", "documents/study.csv", 20 * 1024 * 1024],
  ]);
  assert.match(sent.at(-1).text, /Question 1\/1/);
  assert.match(sent.at(-1).text, /What is ATP\?/);
  assert.doesNotMatch(sent.at(-1).text, /Energy carrier|Cell fuel/);

  await handleUpdate({
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
      text: "Stored energy for the cell",
    },
  });
  assert.equal(gradeCalls.length, 1);
  assert.match(sent.at(-1).text, /Good effort/);
  assert.match(sent.at(-1).text, /Energy carrier/);
  assert.match(sent.at(-1).text, /Cell fuel/);
});

test("handles Telegram commands addressed to the bot and ends the session", async () => {
  const { handleUpdate, sent } = createHarness();
  await handleUpdate(privateDocumentUpdate());
  await handleUpdate({
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
      text: "/skip@RecallTutorBot",
    },
  });
  assert.match(sent.at(-1).text, /Energy carrier/);
  await handleUpdate({
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
      text: "/stop@RecallTutorBot",
    },
  });
  assert.match(sent.at(-1).text, /session cleared/i);
});

test("does not download oversized documents and requires private chats", async () => {
  const { handleUpdate, sent, fileCalls } = createHarness();
  await handleUpdate(privateDocumentUpdate(20 * 1024 * 1024 + 1));
  assert.match(sent.at(-1).text, /over the 20 MB/);
  assert.deepEqual(fileCalls, []);

  await handleUpdate({
    message: {
      chat: { id: -1001, type: "group" },
      from: { id: 12345, is_bot: false },
      text: "hello",
    },
  });
  assert.equal(sent.at(-1).chatId, -1001);
  assert.match(sent.at(-1).text, /private chat/);
});

test("reports invalid or unsupported Telegram documents", async () => {
  const { handleUpdate, sent, fileCalls } = createHarness();
  await handleUpdate({
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
      document: { file_id: "file-2", file_name: "archive.exe", file_size: 30 },
    },
  });
  assert.match(sent.at(-1).text, /unsupported|study file/i);
  assert.deepEqual(fileCalls, []);
});

test("generates recall cards from a document without imported cards", async () => {
  const generated = [];
  const { sent } = createHarness();
  const studyBot = createStudyBot({
    sendText: async (chatId, text) => sent.push({ chatId: Number(chatId), text }),
    gradeAnswer: async () => "Good effort.",
  });
  const handleDocument = createTelegramUpdateHandler({
    api: {
      sendMessage: async (chatId, text) => sent.push({ chatId, text }),
      getFile: async () => ({ file_path: "documents/notes.pdf", file_size: 30 }),
      downloadFile: async () => Buffer.from("Notes about cells"),
    },
    studyBot: {
      startSession: async (chatId, name, cards) => {
        generated.push({ chatId, name, cards });
        await studyBot.startSession(chatId, name, cards);
      },
      handleText: (...args) => studyBot.handleText(...args),
    },
    fileCatalog: createMemoryFileCatalog(),
    parseStudyFile: async () => ({ cards: [], text: "Extracted cell notes" }),
    generateCards: async (text, filename) => {
      generated.push({ text, filename });
      return [{ front: "What is ATP?", back: "Energy carrier", extra: "Cell fuel" }];
    },
    maxFileBytes: 20 * 1024 * 1024,
    logger: { error() {} },
  });

  await handleDocument(privateDocumentUpdate());
  assert.deepEqual(generated, [
    { text: "Extracted cell notes", filename: "biology.csv" },
    {
      chatId: "12345",
      name: "biology.csv",
      cards: [{ front: "What is ATP?", back: "Energy carrier", extra: "Cell fuel" }],
    },
  ]);
  assert.match(sent.at(-1).text, /Question 1\/1/);
});

test("lists saved uploads and lets the same private chat study a selected file", async () => {
  const { handleUpdate, sent, fileCalls } = createHarness();
  await handleUpdate(privateDocumentUpdate());

  await handleUpdate({
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
      text: "/files",
    },
  });
  assert.match(sent.at(-1).text, /1\. biology\.csv/);
  assert.match(sent.at(-1).text, /\/use <number>/);

  await handleUpdate({
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
      text: "/use 1",
    },
  });
  assert.deepEqual(fileCalls, [
    ["getFile", "file-1"],
    ["downloadFile", "documents/study.csv", 20 * 1024 * 1024],
    ["getFile", "file-1"],
    ["downloadFile", "documents/study.csv", 20 * 1024 * 1024],
  ]);
  assert.match(sent.at(-1).text, /Question 1\/1/);
});

test("keeps the saved file list private to its Telegram chat", async () => {
  const { handleUpdate, sent } = createHarness();
  await handleUpdate(privateDocumentUpdate());
  await handleUpdate({
    message: {
      chat: { id: 67890, type: "private" },
      from: { id: 67890 },
      text: "/files",
    },
  });
  assert.match(sent.at(-1).text, /no saved study files/i);
  assert.doesNotMatch(sent.at(-1).text, /biology\.csv/);
});

test("offers upload instructions and rejects a missing saved-file selection", async () => {
  const { handleUpdate, sent } = createHarness();
  await handleUpdate({
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
      text: "/upload",
    },
  });
  assert.match(sent.at(-1).text, /Send a study file/);

  await handleUpdate({
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
      text: "/use 1",
    },
  });
  assert.match(sent.at(-1).text, /not in your library/);
});

test("tags an uploaded file and loads it by its unique alias", async () => {
  const { handleUpdate, sent, fileCalls } = createHarness();
  await handleUpdate(privateDocumentUpdate());

  await handleUpdate({
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
      text: "/tag 1 biology",
    },
  });
  assert.match(sent.at(-1).text, /tagged.*biology.*\/load biology/i);

  await handleUpdate({
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
      text: "/files",
    },
  });
  assert.match(sent.at(-1).text, /\[biology\]/);

  await handleUpdate({
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
      text: "/load BIOLOGY",
    },
  });
  assert.match(sent.at(-1).text, /Question 1\/1/);
  assert.equal(fileCalls.filter(([method]) => method === "getFile").length, 2);
});

test("rejects a tag already assigned to another file", async () => {
  const { handleUpdate, sent, fileCatalog } = createHarness();
  await fileCatalog.saveFile({ chatId: "12345", fileId: "first", fileName: "first.csv", fileSize: 10 });
  await fileCatalog.saveFile({ chatId: "12345", fileId: "second", fileName: "second.csv", fileSize: 20 });
  await fileCatalog.tagFile("12345", 1, "biology");

  await handleUpdate({
    message: {
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
      text: "/tag 2 BIOLOGY",
    },
  });
  assert.match(sent.at(-1).text, /already assigned/i);
});
