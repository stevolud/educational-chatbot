import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createPostgresFileCatalog } from "./postgres-file-catalog.js";
import { createStudyUpdateHandler } from "./study-handler.js";
import { createTelegramApi } from "./telegram-api.js";

const WEBHOOK_PATH = "/telegram-webhook";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_REMEMBERED_UPDATES = 1000;

function sendJson(response, status, payload) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function matchesSecret(received, expected) {
  if (typeof received !== "string") return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

function readBody(request, response, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const contentLength = Number(request.headers["content-length"]);

    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      settled = true;
      sendJson(response, 413, { ok: false, error: "payload too large" });
      request.resume();
      resolve(null);
      return;
    }

    request.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        settled = true;
        chunks.length = 0;
        sendJson(response, 413, { ok: false, error: "payload too large" });
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    request.on("aborted", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Telegram webhook request was aborted."));
    });
  });
}

function rememberUpdate(processedUpdates, updateId) {
  processedUpdates.add(updateId);
  if (processedUpdates.size > MAX_REMEMBERED_UPDATES) {
    processedUpdates.delete(processedUpdates.values().next().value);
  }
}

export function createTelegramWebhookServer({
  handleUpdate,
  secretToken,
  logger = console,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}) {
  if (typeof handleUpdate !== "function") {
    throw new Error("Telegram webhook server requires an update handler.");
  }
  if (typeof secretToken !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(secretToken)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must be 1-256 letters, numbers, underscores, or hyphens.");
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("Telegram webhook body limit must be a positive whole number.");
  }

  const processedUpdates = new Set();
  const inFlightUpdates = new Map();

  async function processUpdate(update) {
    const updateId = update.update_id;
    if (processedUpdates.has(updateId)) return;

    let pending = inFlightUpdates.get(updateId);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => handleUpdate(update))
        .then(() => rememberUpdate(processedUpdates, updateId))
        .finally(() => inFlightUpdates.delete(updateId));
      inFlightUpdates.set(updateId, pending);
    }
    await pending;
  }

  return createServer((request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      sendJson(response, 400, { ok: false, error: "invalid request path" });
      return;
    }

    if (pathname === "/health" && request.method === "GET") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (pathname !== WEBHOOK_PATH) {
      sendJson(response, 404, { ok: false, error: "not found" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (!matchesSecret(request.headers["x-telegram-bot-api-secret-token"], secretToken)) {
      sendJson(response, 401, { ok: false, error: "unauthorized" });
      request.resume();
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
      sendJson(response, 415, { ok: false, error: "expected JSON" });
      request.resume();
      return;
    }

    void (async () => {
      const body = await readBody(request, response, maxBodyBytes);
      if (body === null) return;

      let update;
      try {
        update = JSON.parse(body);
      } catch {
        sendJson(response, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      if (
        update === null
        || typeof update !== "object"
        || Array.isArray(update)
        || !Number.isSafeInteger(update.update_id)
        || update.update_id < 0
      ) {
        sendJson(response, 400, { ok: false, error: "invalid Telegram update" });
        return;
      }

      try {
        await processUpdate(update);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        logger.error(
          "Telegram webhook update failed:",
          error instanceof Error ? error.message : "unknown error",
        );
        sendJson(response, 500, { ok: false, error: "update processing failed" });
      }
    })().catch((error) => {
      logger.error(
        "Telegram webhook request failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      sendJson(response, 500, { ok: false, error: "request processing failed" });
    });
  });
}

export function createTelegramWebhookUrl(hostname) {
  if (typeof hostname !== "string" || !/^[a-z0-9.-]+$/i.test(hostname)) {
    throw new Error("Render did not provide a valid public hostname.");
  }
  return `https://${hostname}${WEBHOOK_PATH}`;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "0.0.0.0");
  });
}

async function main() {
  const api = createTelegramApi(process.env.TELEGRAM_BOT_TOKEN);
  const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secretToken) throw new Error("Set TELEGRAM_WEBHOOK_SECRET before starting the webhook server.");

  const hostname = process.env.RENDER_EXTERNAL_HOSTNAME;
  const webhookUrl = createTelegramWebhookUrl(hostname);
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Render provided an invalid PORT.");
  }

  const telegramBot = await api.call("getMe");
  if (!telegramBot?.username) throw new Error("Telegram did not return this bot's username.");
  const fileCatalog = await createPostgresFileCatalog(process.env.DATABASE_URL);

  const server = createTelegramWebhookServer({
    handleUpdate: createStudyUpdateHandler(api, fileCatalog),
    secretToken,
  });
  try {
    await listen(server, port);
  } catch (error) {
    await fileCatalog.close();
    throw error;
  }

  try {
    await api.call("setWebhook", {
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ["message"],
      max_connections: 1,
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    await fileCatalog.close();
    throw error;
  }

  console.log(`Recall Telegram bot @${telegramBot.username} webhook is listening at ${webhookUrl}.`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(async (error) => {
      try {
        await fileCatalog.close();
      } catch (closeError) {
        console.error("Could not close the Telegram file library:", closeError.message);
        process.exitCode = 1;
      }
      if (error) {
        console.error("Could not close Telegram webhook server:", error.message);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Could not start Recall Telegram webhook:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}
