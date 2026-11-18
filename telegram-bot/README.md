# Recall Telegram study bot

The Telegram bot provides the same active-recall flow as Recall's WhatsApp bot. Send a study file in a private chat and the bot sends one question at a time. Reply with what you remember to receive brief local-model feedback, the correct answer, and any extra card notes. Reply `next` to continue when ready.

## What it supports

- Anki `.apkg` packages, CSV, and Excel `.xlsx` files with question/answer or front/back columns use their existing cards directly.
- PDF, Word, and readable tables without question/answer columns can be turned into up to 15 recall questions by a local Ollama model.
- `skip` reveals the answer and extra notes without feedback. `repeat` repeats the current question or reveal. Use `go 5` or `go to number 5` to jump directly to a question. `help`, `next`, `stop`, and `/start` are supported.
- Only private Telegram chats are supported so conversations do not expose study answers to group members.

The file parsers and study conversation are shared with [Recall WhatsApp](../whatsapp-bot/README.md). Files are processed by the bot host. Anki cards are not sent to Ollama; document text is sent to Ollama only when generating questions, and the active question/answer plus learner reply are used for feedback.

## Requirements

- Node.js 20.6 or newer.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- Ollama running on the bot host, with a model installed. The default is `gemma4:e2b`:

  ```sh
  ollama pull gemma4:e2b
  ```

Telegram messaging and file downloads require an internet connection. Ollama inference and document parsing run on the host.

## Set up and run

1. Create a Telegram bot with BotFather and copy its token into a private `.env` file:

   ```sh
   cp .env.example .env
   ```

   Set `TELEGRAM_BOT_TOKEN` to the token from BotFather. Set `LOCAL_LLM_BASE_URL` or `LOCAL_LLM_MODEL` if using a non-default Ollama endpoint or model. Never commit or share the bot token.
2. Install the shared file-processing dependencies:

   ```sh
   cd ../whatsapp-bot
   npm install
   ```

3. Run Telegram bot tests and start polling:

   ```sh
   cd ../telegram-bot
   npm test
   npm start
   ```

Local `npm start` uses Telegram long polling. The Render deployment uses a webhook so Telegram can wake the free web service when a message arrives.

## Deploy on Render Free

The root `render.yaml` configures a Render Free Web Service with a Telegram webhook and a `/health` endpoint.

1. Push this repository to GitHub and in Render choose **New > Blueprint**, then select the repository and the branch containing `render.yaml`.
2. Provide `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `LOCAL_LLM_BASE_URL` in Render's environment setup. Generate a random secret for `TELEGRAM_WEBHOOK_SECRET` (letters, numbers, `_` and `-` only; 32 random bytes in hex is suitable). Use a trusted, network-accessible Ollama endpoint with the OpenAI-compatible API, usually ending in `/v1`. Never put these values in source control or chat.
3. Ensure the Ollama endpoint has the model named by `LOCAL_LLM_MODEL` (defaults to `gemma4:e2b`). Render runs the bot, not Ollama; do not expose an unauthenticated Ollama server to the public internet.
4. Create the Blueprint and check the service's **Logs**. The server registers its webhook with Telegram at startup. Stop any other long-polling instance using the same bot token. The Blueprint enables automatic deploys from the connected branch.

Render Free Web Services sleep after 15 minutes without inbound traffic. Telegram webhook traffic can wake the service, but the first update after idle can be delayed by a cold start. This is not an always-on 24/7 service. Active study sessions are stored in memory and clear when Render sleeps, restarts, or deploys.

The bot accepts files up to 20 MB. Anki collection databases are limited to 100 MB, source text for question generation to 50,000 characters, and generated question sets to 15 cards. Scanned image-only PDFs need OCR before they can be used.

Active study sessions are stored in memory and clear when the process restarts. Use only one running bot instance for each token, whether using local polling or the Render webhook.
