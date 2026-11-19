import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresFileCatalog } from "./postgres-file-catalog.js";

class FakePool {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.queries = [];
    this.closed = false;
    FakePool.instances.push(this);
  }

  async query(sql, values = []) {
    this.queries.push({ sql, values });
    if (sql.includes("COUNT(*)")) return { rows: [{ total: "1" }] };
    if (sql.includes("WITH selected")) {
      return {
        rows: [{
          file_id: "saved-file",
          file_name: "biology.csv",
          file_size: "4096",
          tag: values[2],
          uploaded_at: new Date("2026-01-01T00:00:00.000Z"),
        }],
      };
    }
    if (sql.includes("LOWER(tag)")) {
      return {
        rows: [{
          file_id: "saved-file",
          file_name: "biology.csv",
          file_size: "4096",
          tag: "biology",
          uploaded_at: new Date("2026-01-01T00:00:00.000Z"),
        }],
      };
    }
    if (sql.includes("SELECT file_id")) {
      return {
        rows: [{
          file_id: "saved-file",
          file_name: "biology.csv",
          file_size: "4096",
          tag: null,
          uploaded_at: new Date("2026-01-01T00:00:00.000Z"),
        }],
      };
    }
    return { rows: [] };
  }

  async end() {
    this.closed = true;
  }
}

test("initializes PostgreSQL and stores and lists chat-scoped file references", async () => {
  FakePool.instances.length = 0;
  const catalog = await createPostgresFileCatalog("postgres://database", { PoolClass: FakePool });
  const pool = FakePool.instances[0];
  assert.equal(pool.options.connectionString, "postgres://database");
  assert.match(pool.queries[0].sql, /CREATE TABLE IF NOT EXISTS telegram_study_files/);
  assert.match(pool.queries[1].sql, /ADD COLUMN IF NOT EXISTS tag/);
  assert.match(pool.queries[2].sql, /CREATE UNIQUE INDEX IF NOT EXISTS telegram_study_files_chat_tag_unique/);

  await catalog.saveFile({
    chatId: "123",
    fileId: "saved-file",
    fileName: "biology.csv",
    fileSize: 4096,
  });
  const list = await catalog.listFiles("123", { limit: 10, offset: 0 });
  assert.deepEqual(list, {
    files: [{
      fileId: "saved-file",
      fileName: "biology.csv",
      fileSize: 4096,
      tag: null,
      uploadedAt: "2026-01-01T00:00:00.000Z",
    }],
    total: 1,
  });
  assert.deepEqual(pool.queries[3].values, ["123", "saved-file", "biology.csv", 4096]);

  const tagged = await catalog.tagFile("123", 1, "biology");
  assert.equal(tagged.tag, "biology");
  assert.equal((await catalog.getFileByTag("123", "biology")).fileId, "saved-file");
  await catalog.close();
  assert.equal(pool.closed, true);
});

test("requires a database URL", async () => {
  await assert.rejects(createPostgresFileCatalog(""), /DATABASE_URL/);
});
