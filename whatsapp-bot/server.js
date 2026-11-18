import "dotenv/config";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createStudyBot } from "./conversation.js";
import { isDuplicateMessage, isValidSignature } from "./webhook-security.js";
import { generateCards, gradeAnswer as gradeStudyAnswer, MAX_MEDIA_BYTES, parseStudyFile } from "./study-files.js";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION;
const LOCAL_LLM_BASE_URL = (process.env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/$/, "");
const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || "gemma4:e2b";

function requireConfig() {
  for (const key of ["VERIFY_TOKEN", "META_APP_SECRET", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_GRAPH_VERSION"]) {
    if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
  }
}

export function splitMessage(body, limit = 4000) {
  if (!Number.isInteger(limit) || limit < 2) {
    throw new Error("WhatsApp message limit must be a whole number greater than one.");
  }
  const chunks = [];
  let remaining = body;
  while (remaining.length > limit) {
    let end = remaining.lastIndexOf("\n", limit);
    if (end < Math.floor(limit / 2)) end = limit;
    if (end > 0 && end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end -= 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendText(to, body) {
  requireConfig();
  for (const chunk of splitMessage(body)) {
    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: false, body: chunk },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`WhatsApp send failed (${response.status}): ${await response.text()}`);
  }
}

async function downloadMedia(mediaId) {
  const headers = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const meta = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!meta.ok) throw new Error("Could not retrieve WhatsApp media metadata.");
  const { url } = await meta.json();
  let mediaUrl;
  try {
    mediaUrl = new URL(url);
  } catch {
    throw new Error("WhatsApp returned an invalid media URL.");
  }
  const trustedHost = mediaUrl.hostname === "graph.facebook.com"
    || mediaUrl.hostname === "lookaside.fbsbx.com"
    || mediaUrl.hostname.endsWith(".fbcdn.net")
    || mediaUrl.hostname.endsWith(".fbsbx.com");
  if (mediaUrl.protocol !== "https:" || !trustedHost) {
    throw new Error("WhatsApp returned an unsupported media URL.");
  }
  const file = await fetch(mediaUrl, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!file.ok) throw new Error("Could not download the WhatsApp attachment.");
  if (!file.body) throw new Error("The WhatsApp attachment response was empty.");
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of file.body) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_MEDIA_BYTES) throw new Error("That file is over the 20 MB study-bot limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function gradeAnswer(card, answer) {
  try {
    return await gradeStudyAnswer(card, answer);
  } catch (error) {
    console.error("Local answer feedback unavailable:", error instanceof Error ? error.message : "unknown error");
    return "Thanks for trying. Compare your response with the answer below.";
  }
}

const studyBot = createStudyBot({ sendText, gradeAnswer });

async function handleMessage(message) {
  const from = message.from;
  if (!from) return;
  if (message.type === "text") {
    await studyBot.handleText(from, message.text?.body || "");
    return;
  }
  if (message.type !== "document" || !message.document?.id) {
    await sendText(from, "Please attach a study file: .apkg, .pdf, .xlsx, .csv, .docx or .doc.");
    return;
  }

  const filename = message.document.filename || "study-file";
  try {
    await sendText(from, `I received *${filename}*. Reading it and preparing your recall questions…`);
    const buffer = await downloadMedia(message.document.id);
    const parsed = await parseStudyFile(buffer, filename);
    const cards = parsed.cards.length ? parsed.cards : await generateCards(parsed.text, filename);
    if (!cards.length) throw new Error("I couldn't make any usable questions from that file.");
    await studyBot.startSession(from, filename, cards);
  } catch (error) {
    await sendText(from, `I couldn't prepare that file: ${error instanceof Error ? error.message : "unsupported or unreadable file"}`);
  }
}

function createMessageQueue(handler) {
  const queues = new Map();
  return (message) => {
    const sender = message.from;
    if (!sender) return Promise.resolve();
    const previous = queues.get(sender) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => handler(message));
    queues.set(sender, current);
    return current.finally(() => {
      if (queues.get(sender) === current) queues.delete(sender);
    });
  };
}

export function createApp({ env = process.env, onMessage = handleMessage, logger = console } = {}) {
  const app = express();
  const processedMessages = new Map();
  const queueMessage = createMessageQueue(onMessage);

  app.use(express.json({
    limit: "2mb",
    verify: (req, _res, body) => { req.rawBody = Buffer.from(body); },
  }));
  app.get("/webhook", (req, res) => {
    const verifyToken = req.query["hub.verify_token"];
    const configuredToken = env.VERIFY_TOKEN;
    const tokenMatches = typeof verifyToken === "string"
      && typeof configuredToken === "string"
      && Buffer.byteLength(verifyToken) === Buffer.byteLength(configuredToken)
      && timingSafeEqual(Buffer.from(verifyToken), Buffer.from(configuredToken));
    if (req.query["hub.mode"] !== "subscribe" || !tokenMatches) return res.sendStatus(403);
    return res.status(200).send(req.query["hub.challenge"]);
  });
  app.post("/webhook", (req, res) => {
    if (!isValidSignature(req.rawBody, req.get("x-hub-signature-256"), env.META_APP_SECRET)) {
      return res.sendStatus(401);
    }
    res.sendStatus(200);
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    const messages = entries.flatMap((entry) =>
      (Array.isArray(entry?.changes) ? entry.changes : [])
        .flatMap((change) => Array.isArray(change?.value?.messages) ? change.value.messages : []),
    );
    for (const message of messages) {
      const id = message.id;
      if (id && isDuplicateMessage(id, processedMessages)) continue;
      void queueMessage(message).catch((error) => {
        logger.error("Message processing failed:", error instanceof Error ? error.message : "unknown error");
      });
    }
    return undefined;
  });
  app.get("/health", async (_req, res) => {
    let modelServerAvailable = false;
    let modelAvailable = false;
    try {
      const response = await fetch(`${LOCAL_LLM_BASE_URL}/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        modelServerAvailable = true;
        const data = await response.json();
        modelAvailable = (data.data || []).some((model) => model.id === LOCAL_LLM_MODEL);
      }
    } catch (error) {
      logger.warn("Local model health check failed:", error instanceof Error ? error.message : "unknown error");
    }
    res.json({
      ok: true,
      aiProvider: "ollama-local",
      modelServerAvailable,
      model: LOCAL_LLM_MODEL,
      modelAvailable,
      whatsappConfigured: Boolean(env.VERIFY_TOKEN && env.META_APP_SECRET && env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_GRAPH_VERSION),
      whatsappTransport: "meta-cloud-api-requires-internet",
    });
  });
  return app;
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => console.log(`Recall WhatsApp bot listening on ${port}`));
}
