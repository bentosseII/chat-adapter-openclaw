import { createServer } from "node:http";
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createOpenClawAdapter } from "../src/index";

const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789";
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";

if (!gatewayToken) {
  throw new Error("Missing OPENCLAW_GATEWAY_TOKEN");
}

const bot = new Chat({
  userName: "openclaw-echo",
  adapters: {
    openclaw: createOpenClawAdapter({ gatewayUrl, gatewayToken }),
  },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`echo: ${message.text}`);
});

bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;
  await thread.post(`echo: ${message.text}`);
});

const server = createServer(async (req, res) => {
  if (req.url !== "/webhooks/openclaw" || req.method !== "POST") {
    res.writeHead(404).end("not found");
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));

  const request = new Request("http://localhost:8787/webhooks/openclaw", {
    method: "POST",
    headers: req.headers as Record<string, string>,
    body: Buffer.concat(chunks),
  });

  const response = await bot.webhooks.openclaw(request);
  const text = await response.text();

  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(text || "ok");
});

server.listen(8787, () => {
  console.log("Echo bot listening on http://localhost:8787/webhooks/openclaw");
});
