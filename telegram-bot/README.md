# Recall Telegram study bot

The Telegram bot provides the same active-recall flow as Recall's WhatsApp bot. Send a study file in a private chat and the bot sends one question at a time. Reply with what you remember to receive brief local-model feedback, the correct answer, and any extra card notes. Reply `next` to continue when ready.

## What it supports

- Anki `.apkg` packages, CSV, and Excel `.xlsx` files with question/answer or front/back columns use their existing cards directly.
- PDF, Word, and readable tables without question/answer columns can be turned into up to 15 recall questions by a local Ollama model.
- `skip` reveals the answer and extra notes without feedback. `repeat` repeats the current question or reveal. `help`, `next`, `stop`, and `/start` are supported.
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

The service uses Telegram's long-polling API and does not need a public webhook or inbound port. Keep it running on a trusted host with outbound internet access and access to Ollama. On first use, open the bot's private chat and send `/start`, then upload a supported study document as a file.

## Keep the bot running on Render

The root `render.yaml` declares a single, always-on Render background worker. Background workers require a paid instance; do not change it to a free web service, which may sleep and is not suitable for Telegram long polling.

1. Push this repository to GitHub and in Render choose **New > Blueprint**, then select the repository. Render reads `render.yaml` and asks you to provide `TELEGRAM_BOT_TOKEN` and `LOCAL_LLM_BASE_URL`. Enter the token from BotFather and the base URL of a trusted, network-accessible Ollama server using its OpenAI-compatible API (usually ending in `/v1`). Never put either value in source control.
2. Ensure the configured Ollama server has the model named by `LOCAL_LLM_MODEL` (defaults to `gemma4:e2b`). Render runs the bot worker, not Ollama; do not expose an unauthenticated Ollama server to the public internet.
3. Create the Blueprint and check the worker's **Logs** in Render. The Blueprint enables automatic deploys from the connected branch. Keep one worker instance per bot token; scaling to multiple instances conflicts with Telegram long polling.

The worker needs no public URL or inbound port. Render restarts it when the process exits, but active study sessions are in memory and clear on restarts or deploys.

The bot accepts files up to 20 MB. Anki collection databases are limited to 100 MB, source text for question generation to 50,000 characters, and generated question sets to 15 cards. Scanned image-only PDFs need OCR before they can be used.

Active study sessions are stored in memory and clear when the process restarts. Long polling processes updates in order; run one instance for each bot token.
