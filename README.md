# @chat-adapter/openclaw

OpenClaw adapter for [Chat SDK](https://www.npmjs.com/package/chat).

Use Chat SDK bot logic against OpenClaw sessions via gateway webhooks + API.

## Install

```bash
npm i @chat-adapter/openclaw chat
```

## Usage

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createOpenClawAdapter } from "@chat-adapter/openclaw";

const adapter = createOpenClawAdapter({
  gatewayUrl: process.env.OPENCLAW_GATEWAY_URL!,
  gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN!,
  webhookSecret: process.env.OPENCLAW_WEBHOOK_SECRET,
});

const bot = new Chat({
  userName: "openclaw-bot",
  adapters: { openclaw: adapter },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.post(`Echo: ${message.text}`);
});

// In your HTTP handler:
// return bot.webhooks.openclaw(request)
```

## Thread mapping

- Chat SDK Channel → OpenClaw namespace
- Chat SDK Thread → OpenClaw session key
- Encoded thread ID: `openclaw:<namespace>:<sessionKey>`

## Implemented adapter methods

- `initialize`
- `handleWebhook`
- `encodeThreadId` / `decodeThreadId`
- `fetchThread`
- `fetchMessages`
- `postMessage`
- `editMessage`
- `deleteMessage`
- `addReaction`
- `parseMessage`

## Local test

See `examples/echo-bot.ts`.
