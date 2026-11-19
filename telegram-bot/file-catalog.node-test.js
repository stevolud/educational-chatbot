import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryFileCatalog } from "./file-catalog.js";

test("stores files privately by chat and lists newest uploads first with pagination", async () => {
  const catalog = createMemoryFileCatalog();
  await catalog.saveFile({ chatId: "123", fileId: "old", fileName: "old.csv", fileSize: 10 });
  await catalog.saveFile({ chatId: "123", fileId: "new", fileName: "new.csv", fileSize: 20 });
  await catalog.saveFile({ chatId: "456", fileId: "private", fileName: "private.csv", fileSize: 30 });

  const firstPage = await catalog.listFiles("123", { limit: 1, offset: 0 });
  assert.deepEqual(firstPage, {
    files: [{
      fileId: "new",
      fileName: "new.csv",
      fileSize: 20,
      tag: null,
      uploadedAt: firstPage.files[0].uploadedAt,
    }],
    total: 2,
  });
  assert.equal((await catalog.listFiles("123", { limit: 1, offset: 1 })).files[0].fileId, "old");
  assert.equal((await catalog.listFiles("456", { limit: 10, offset: 0 })).files[0].fileName, "private.csv");
  assert.equal((await catalog.listFiles("789", { limit: 10, offset: 0 })).total, 0);
});

test("updates duplicate uploads and rejects invalid page bounds", async () => {
  const catalog = createMemoryFileCatalog();
  await catalog.saveFile({ chatId: "123", fileId: "same", fileName: "first.csv", fileSize: 10 });
  await catalog.saveFile({ chatId: "123", fileId: "same", fileName: "renamed.csv", fileSize: 20 });

  const result = await catalog.listFiles("123", { limit: 10, offset: 0 });
  assert.equal(result.total, 1);
  assert.equal(result.files[0].fileName, "renamed.csv");
  await assert.rejects(catalog.listFiles("123", { limit: 0, offset: 0 }), /page size/);
});

test("assigns unique per-chat tags and looks up files by tag", async () => {
  const catalog = createMemoryFileCatalog();
  await catalog.saveFile({ chatId: "123", fileId: "one", fileName: "one.csv", fileSize: 10 });
  await catalog.saveFile({ chatId: "123", fileId: "two", fileName: "two.csv", fileSize: 20 });

  const tagged = await catalog.tagFile("123", 1, "Biology_Review");
  assert.equal(tagged.tag, "biology_review");
  assert.equal((await catalog.getFileByTag("123", "BIOLOGY_REVIEW")).fileId, "two");
  await assert.rejects(catalog.tagFile("123", 2, "biology_review"), /already assigned/);
  assert.equal(await catalog.getFileByTag("456", "biology_review"), null);

  await catalog.saveFile({ chatId: "123", fileId: "two", fileName: "renamed.csv", fileSize: 20 });
  assert.equal((await catalog.getFileByTag("123", "biology_review")).fileName, "renamed.csv");
});
