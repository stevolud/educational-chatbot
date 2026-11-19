import pg from "pg";

const { Pool } = pg;

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS telegram_study_files (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    file_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size BIGINT,
    tag TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chat_id, file_id)
  )
`;

const ADD_TAG_COLUMN = "ALTER TABLE telegram_study_files ADD COLUMN IF NOT EXISTS tag TEXT";
const CREATE_TAG_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS telegram_study_files_chat_tag_unique
  ON telegram_study_files (chat_id, LOWER(tag))
  WHERE tag IS NOT NULL
`;

export async function createPostgresFileCatalog(databaseUrl, { PoolClass = Pool } = {}) {
  if (typeof databaseUrl !== "string" || !databaseUrl) {
    throw new Error("Set DATABASE_URL to enable the persistent Telegram file library.");
  }

  const pool = new PoolClass({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    max: 5,
  });

  try {
    await pool.query(CREATE_TABLE);
    await pool.query(ADD_TAG_COLUMN);
    await pool.query(CREATE_TAG_INDEX);
  } catch (error) {
    await pool.end();
    throw new Error(`Could not initialize the Telegram file library: ${error instanceof Error ? error.message : "database error"}`);
  }

  return {
    async saveFile({ chatId, fileId, fileName, fileSize }) {
      if (typeof fileId !== "string" || !fileId || typeof fileName !== "string" || !fileName) {
        throw new Error("A saved file needs its Telegram file ID and name.");
      }
      await pool.query(
        `INSERT INTO telegram_study_files (chat_id, file_id, file_name, file_size)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (chat_id, file_id) DO UPDATE
         SET file_name = EXCLUDED.file_name, file_size = EXCLUDED.file_size, uploaded_at = NOW()`,
        [String(chatId), fileId, fileName, Number.isSafeInteger(fileSize) && fileSize >= 0 ? fileSize : null],
      );
    },
    async listFiles(chatId, { limit, offset }) {
      if (!/^-?\d+$/.test(String(chatId))) throw new Error("Telegram chat ID must be an integer.");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error("File catalog page size must be from 1 to 50.");
      }
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("File catalog offset must be a non-negative whole number.");
      }

      const [countResult, filesResult] = await Promise.all([
        pool.query("SELECT COUNT(*) AS total FROM telegram_study_files WHERE chat_id = $1", [String(chatId)]),
        pool.query(
          `SELECT file_id, file_name, file_size, tag, uploaded_at
           FROM telegram_study_files
           WHERE chat_id = $1
           ORDER BY uploaded_at DESC, id DESC
           LIMIT $2 OFFSET $3`,
          [String(chatId), limit, offset],
        ),
      ]);
      const total = Number(countResult.rows[0]?.total);
      if (!Number.isSafeInteger(total) || total < 0) {
        throw new Error("The Telegram file library returned an invalid file count.");
      }
      return {
        files: filesResult.rows.map((row) => ({
          fileId: row.file_id,
          fileName: row.file_name,
          fileSize: row.file_size === null ? null : Number(row.file_size),
          tag: row.tag,
          uploadedAt: row.uploaded_at instanceof Date ? row.uploaded_at.toISOString() : String(row.uploaded_at),
        })),
        total,
      };
    },
    async tagFile(chatId, number, tag) {
      if (!/^-?\d+$/.test(String(chatId))) throw new Error("Telegram chat ID must be an integer.");
      if (!Number.isSafeInteger(number) || number < 1) throw new Error("File number must be positive.");
      if (typeof tag !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(tag)) {
        throw new Error("Tags must start with a letter or number and contain only letters, numbers, underscores, or hyphens.");
      }
      try {
        const result = await pool.query(
          `WITH selected AS (
             SELECT id FROM telegram_study_files
             WHERE chat_id = $1
             ORDER BY uploaded_at DESC, id DESC
             OFFSET $2 LIMIT 1
           )
           UPDATE telegram_study_files AS file
           SET tag = $3
           FROM selected
           WHERE file.id = selected.id
           RETURNING file_id, file_name, file_size, tag, uploaded_at`,
          [String(chatId), number - 1, tag.toLowerCase()],
        );
        const row = result.rows[0];
        if (!row) return null;
        return {
          fileId: row.file_id,
          fileName: row.file_name,
          fileSize: row.file_size === null ? null : Number(row.file_size),
          tag: row.tag,
          uploadedAt: row.uploaded_at instanceof Date ? row.uploaded_at.toISOString() : String(row.uploaded_at),
        };
      } catch (error) {
        if (error?.code === "23505") throw new Error("That tag is already assigned to another file in your library.");
        throw error;
      }
    },
    async getFileByTag(chatId, tag) {
      if (!/^-?\d+$/.test(String(chatId))) throw new Error("Telegram chat ID must be an integer.");
      if (typeof tag !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(tag)) {
        throw new Error("Tags must start with a letter or number and contain only letters, numbers, underscores, or hyphens.");
      }
      const result = await pool.query(
        `SELECT file_id, file_name, file_size, tag, uploaded_at
         FROM telegram_study_files
         WHERE chat_id = $1 AND LOWER(tag) = LOWER($2)`,
        [String(chatId), tag],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        fileId: row.file_id,
        fileName: row.file_name,
        fileSize: row.file_size === null ? null : Number(row.file_size),
        tag: row.tag,
        uploadedAt: row.uploaded_at instanceof Date ? row.uploaded_at.toISOString() : String(row.uploaded_at),
      };
    },
    close: () => pool.end(),
  };
}
