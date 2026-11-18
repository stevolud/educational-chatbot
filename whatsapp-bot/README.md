# Recall WhatsApp study bot

This service connects Recall's flashcard workflow to the WhatsApp Cloud API. Send the bot a study file and it sends one question at a time. Reply with what you remember to receive brief feedback, the card's answer, and any extra notes. Reply `next` to continue when ready. The CSV, Anki, Excel, PDF, and Word importers and active-recall conversation flow are shared with the [Telegram bot](../telegram-bot/README.md).

## What it supports

- Anki `.apkg` packages, CSV and Excel `.xlsx` files with question/answer (or front/back) columns use their existing cards directly.
- PDF, Word, and readable tables without question/answer columns can be turned into up to 15 recall questions by a local Ollama model.
- Answers include the card's extra/explanation field when one exists. `skip` reveals the answer and extra without grading.
- `next` or `continue` advances after the reveal; `repeat` repeats the current question or reveal; `stop`, `reset`, or `cancel` ends the session; `help` explains the flow.

Anki files are read locally by the service. They are not sent to the model. The model receives source text only when it needs to generate questions, and receives the active question, expected answer, and learner's reply to provide feedback.

## Requirements

- Node.js 20 or newer.
- A Meta app with the WhatsApp product, a WhatsApp Cloud API phone number, a permanent access token, and a public HTTPS webhook URL.
- Ollama running locally with a model available. The default is `gemma4:e2b`; install it with:

  ```sh
  ollama pull gemma4:e2b
  ```

WhatsApp Cloud API requires an internet connection and cannot receive or send messages offline. Ollama and file processing remain on the host running this service.

## Configure and run

1. Copy `.env.example` to `.env`. Fill in the WhatsApp Cloud API token, phone number ID, webhook verification token, Meta app secret, and a Graph API version enabled for your Meta app. Keep `.env` private.
2. Set `LOCAL_LLM_BASE_URL` and `LOCAL_LLM_MODEL` if Ollama is not at its default OpenAI-compatible endpoint (`http://127.0.0.1:11434/v1`) or you installed a different model.
3. Install dependencies and run the checks:

   ```sh
   npm install
   npm test
   npm start
   ```

   The service listens on port `3000` by default; set `PORT` to change it. Ollama must also be running and reachable from the service.
4. Expose the service through a trusted HTTPS tunnel or deploy it to a host that has outbound access to Ollama. In the Meta developer dashboard, configure the callback URL as `https://<your-host>/webhook`, use the same `VERIFY_TOKEN`, and subscribe to the WhatsApp `messages` webhook field.
5. Send the configured WhatsApp number a supported study document. The bot acknowledges the file, prepares the deck, and sends the first question.

`GET /health` reports whether the local model server and selected model are reachable and whether the WhatsApp environment variables are configured. The Meta webhook uses its challenge token for subscription verification and validates every POST with the app-secret HMAC signature.

## Limits and session storage

Files are limited to 20 MB and Anki collection databases to 100 MB. Source text passed to question generation is limited to 50,000 characters; generated question sets are capped at 15. Image-only scanned PDFs need OCR before they can be used.

Active conversations are held in memory and are cleared if the service restarts. Run one service instance for a given phone number unless session and webhook-deduplication storage are moved to a shared persistent store.
