# Recall Telegram study bot

The Telegram bot provides the same active-recall flow as Recall's WhatsApp bot. Send a study file in a private chat and the bot sends one question at a time. Reply with what you remember to receive brief local-model feedback, the correct answer, and any extra card notes. Reply `next` to continue when ready.

## What it supports

- Anki `.apkg` packages, CSV, and Excel `.xlsx` files with question/answer or front/back columns use their existing cards directly.
- PDF, Word, and readable tables without question/answer columns can be turned into up to 15 recall questions by a local Ollama model.
- `skip` reveals the answer and extra notes without feedback. `repeat` repeats the current question or reveal. Use `go 5` or `go to number 5` to jump directly to a question. Use `/files` to list saved uploads, `/use 1` to choose one, `/tag 1 biology` to give a file a unique tag, or `/load biology` to open it by tag. Send a new document or use `/upload` to add another file.
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

The root [render.yaml](../render.yaml) configures a Render Free Web Service with a Telegram webhook and a `/health` endpoint.

1. Create a new Telegram bot in [@BotFather](https://t.me/BotFather) and copy its token. Keep the token private; do not commit it to the repository.
2. Push this repository to GitHub and in Render choose **New > Blueprint**, then select the repository and the branch containing `render.yaml`.
3. In your Supabase project, open **Connect**, choose **Session pooler**, and copy its connection URI. Supabase Free direct database connections may require IPv6, so use the session pooler from Render. In the Render service's **Environment** settings, add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL` (optional; defaults to `gemma4:e2b`), and `DATABASE_URL`; set `DATABASE_URL` to that Supabase URI, including `sslmode=require`, and replace its password placeholder. Percent-encode reserved characters in the database password. Keep the URI private. Generate `TELEGRAM_WEBHOOK_SECRET` from 32 random bytes (hex is suitable). Use a trusted Ollama endpoint with its OpenAI-compatible API, usually ending in `/v1`.
4. Ensure the Ollama endpoint has the model named by `LOCAL_LLM_MODEL`. Render runs the bot, not Ollama; do not expose an unauthenticated Ollama server to the public internet.
5. Create the Blueprint and check the service's **Logs**. The server registers its webhook with Telegram at startup using the service's `RENDER_EXTERNAL_HOSTNAME`. Stop any other long-polling or webhook instance using the same bot token. The Blueprint enables automatic deploys from the connected branch.

Render Free Web Services sleep after 15 minutes without inbound traffic. Telegram webhook traffic can wake the service, but the first update after idle can be delayed by a cold start. This is not an always-on 24/7 service. Active study sessions are stored in memory and clear when Render sleeps, restarts, or deploys. The file library stores only each private chat's filename and Telegram file ID; Telegram retains the actual uploaded file. Supabase Free includes 500 MB of database storage, but projects pause after a week of inactivity; resume the Supabase project if the bot reports a database connection error.

The bot accepts files up to 20 MB. Anki collection databases are limited to 100 MB, source text for question generation to 50,000 characters, and generated question sets to 15 cards. Scanned image-only PDFs need OCR before they can be used.

Local polling keeps the file library in memory until the process exits. The Render webhook uses Supabase PostgreSQL so saved uploads remain available across service sleeps and deploys while the Supabase project is active. Use only one running bot instance for each token, whether using local polling or the Render webhook.

## Connect another Telegram bot (Recall/Anki tutor)

To run a second Telegram bot with the same Recall/Anki study flow:

1. Create another bot with [@BotFather](https://t.me/BotFather) and copy its new token. Each Telegram bot must have its own token.
2. **Render webhook:** create another Render Web Service from this repository (uncomment/adapt the example in [render.yaml](../render.yaml), or create the service manually in Render with the same build/start commands: `npm install --prefix whatsapp-bot && npm ci --prefix telegram-bot`, `node telegram-bot/webhook-server.js`, health check `/health`). Give it a unique service name.
3. Set that service's environment variables to values for the new bot: `TELEGRAM_BOT_TOKEN` (new token), `TELEGRAM_WEBHOOK_SECRET` (a different random secret), `LOCAL_LLM_BASE_URL`, optional `LOCAL_LLM_MODEL`, and `DATABASE_URL`. Do not reuse the same token across running instances. Prefer a separate `DATABASE_URL`/database for each bot so saved-file libraries and tags stay isolated; the webhook catalog stores files by Telegram chat ID, and the same user has the same private chat ID across different bots.
4. Deploy/start the service and confirm in logs that it prints `Recall Telegram bot @<username> webhook is listening...` and successfully registers its webhook. Stop any local polling or other deployment using that same token.

**Local polling (alternative):** run a separate process with its own `TELEGRAM_BOT_TOKEN` (for example a separate `.env` file passed via your shell/environment when starting). Only one poller or webhook can receive updates for a given token at a time.

## Recall/Anki tutor behavior

The study conversation is implemented in [../whatsapp-bot/conversation.js](../whatsapp-bot/conversation.js) (one question at a time, answer/skip/reveal/next/repeat/go flow) and reused by Telegram via [study-handler.js](./study-handler.js). File parsing, Anki `.apkg` import, document-to-question generation, and answer feedback are implemented in [../whatsapp-bot/study-files.js](../whatsapp-bot/study-files.js).

- **Active recall flow:** learners answer before reveal; `skip` reveals without feedback; `next` advances; `repeat`/`go <n>` navigate.
- **Answer feedback ("tutor"):** when a learner answers (not skip), `gradeAnswer` sends the question, expected answer, and learner answer to the local Ollama chat model (`LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`) using the prompt in `study-files.js`. If the local model is unavailable, the bot falls back to a neutral compare-with-answer message.
- **Question generation:** for readable documents/tables without explicit question/answer columns, `generateCards` asks the local model to produce up to 15 JSON flashcards from the source text.
- **Customization:** to change tutoring style, strictness, hints, or card-generation behavior, edit the system prompts in `whatsapp-bot/study-files.js` and/or change `LOCAL_LLM_MODEL`. This is prompt/model configuration, not ML training inside this repository. Actual model fine-tuning must be done with your Ollama/model tooling outside this codebase.
