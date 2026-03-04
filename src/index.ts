import { createHmac, timingSafeEqual } from "node:crypto";
import {
  Message,
  markdownToPlainText,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type RawMessage,
  type ThreadInfo,
  type WebhookOptions,
  getEmoji,
  isCardElement,
} from "chat";

export interface OpenClawAdapterConfig {
  gatewayUrl: string;
  gatewayToken: string;
  webhookSecret?: string;
  namespace?: string;
}

type OpenClawThreadId = {
  namespace: string;
  sessionKey: string;
};

type OpenClawMessage = {
  id: string;
  sessionKey: string;
  namespace?: string;
  role?: "user" | "assistant" | "system";
  text?: string;
  content?: string;
  createdAt?: string;
  updatedAt?: string;
  edited?: boolean;
  authorId?: string;
  authorName?: string;
  channel?: string;
  raw?: unknown;
};

type OpenClawWebhookEvent = {
  type: string;
  timestamp?: string;
  data?: Record<string, unknown>;
};

const DEFAULT_NAMESPACE = "openclaw";

export function createOpenClawAdapter(
  config: OpenClawAdapterConfig
): Adapter<OpenClawThreadId, OpenClawMessage> {
  return new OpenClawAdapter(config);
}

class OpenClawAdapter implements Adapter<OpenClawThreadId, OpenClawMessage> {
  readonly name = "openclaw";
  readonly userName = "openclaw";

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly webhookSecret?: string;
  private readonly defaultNamespace: string;

  private chat?: ChatInstance;

  constructor(config: OpenClawAdapterConfig) {
    if (!config.gatewayUrl?.trim()) {
      throw new Error("gatewayUrl is required");
    }
    if (!config.gatewayToken?.trim()) {
      throw new Error("gatewayToken is required");
    }

    this.baseUrl = config.gatewayUrl.replace(/\/$/, "");
    this.token = config.gatewayToken;
    this.webhookSecret = config.webhookSecret;
    this.defaultNamespace = config.namespace ?? DEFAULT_NAMESPACE;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    await this.request("/health", { method: "GET" }).catch(() => undefined);
  }

  encodeThreadId(platformData: OpenClawThreadId): string {
    return `${this.name}:${platformData.namespace}:${platformData.sessionKey}`;
  }

  decodeThreadId(threadId: string): OpenClawThreadId {
    const [adapter, namespace, ...rest] = threadId.split(":");
    if (adapter !== this.name || !namespace || rest.length === 0) {
      throw new Error(`Invalid OpenClaw thread ID: ${threadId}`);
    }
    return {
      namespace,
      sessionKey: rest.join(":"),
    };
  }

  channelIdFromThreadId(threadId: string): string {
    const { namespace } = this.decodeThreadId(threadId);
    return `${this.name}:${namespace}`;
  }

  async handleWebhook(
    request: Request,
    options?: WebhookOptions
  ): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const rawBody = await request.text();
    if (!this.verifyWebhookSignature(request, rawBody)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let event: OpenClawWebhookEvent;
    try {
      event = JSON.parse(rawBody) as OpenClawWebhookEvent;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const data = (event.data ?? {}) as Record<string, unknown>;
    const sessionKey = String(data.sessionKey ?? data.session_id ?? "");
    if (!sessionKey) {
      return new Response("Missing sessionKey", { status: 400 });
    }

    const namespace = String(data.namespace ?? this.defaultNamespace);
    const threadId = this.encodeThreadId({ namespace, sessionKey });

    if (event.type === "message.created" || event.type === "message") {
      if (!this.chat) {
        return new Response("Adapter not initialized", { status: 500 });
      }
      const rawMessage = this.toRawWebhookMessage(data, sessionKey, namespace);
      this.chat.processMessage(this, threadId, this.parseMessage(rawMessage), options);
    }

    if (event.type === "reaction.added") {
      if (!this.chat) {
        return new Response("Adapter not initialized", { status: 500 });
      }
      const rawEmoji = String(data.emoji ?? "");
      const messageId = String(data.messageId ?? data.message_id ?? "");
      if (rawEmoji && messageId) {
        this.chat.processReaction(
          {
            adapter: this,
            threadId,
            messageId,
            added: true,
            emoji: getEmoji(rawEmoji),
            rawEmoji,
            raw: data,
            user: {
              userId: String(data.userId ?? data.user_id ?? "unknown"),
              userName: String(data.userName ?? data.user_name ?? "unknown"),
              fullName: String(data.userName ?? data.user_name ?? "Unknown"),
              isBot: false,
              isMe: false,
            },
          },
          options
        );
      }
    }

    return new Response("ok", { status: 200 });
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { namespace, sessionKey } = this.decodeThreadId(threadId);
    return {
      id: threadId,
      channelId: `${this.name}:${namespace}`,
      channelName: namespace,
      isDM: true,
      metadata: { sessionKey, namespace },
    };
  }

  async fetchMessages(
    threadId: string,
    options?: FetchOptions
  ): Promise<FetchResult<OpenClawMessage>> {
    const { namespace, sessionKey } = this.decodeThreadId(threadId);
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    if (options?.direction) params.set("direction", options.direction);

    const query = params.toString();
    const response = await this.request(
      `/v1/sessions/${encodeURIComponent(namespace)}/${encodeURIComponent(
        sessionKey
      )}/messages${query ? `?${query}` : ""}`,
      { method: "GET" }
    );

    const body = (await response.json()) as {
      messages?: OpenClawMessage[];
      nextCursor?: string;
      hasMore?: boolean;
    };

    const parsed = (body.messages ?? []).map((m) => this.parseMessage(m));
    return {
      messages: parsed,
      nextCursor: body.nextCursor,
    };
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<OpenClawMessage>> {
    const { namespace, sessionKey } = this.decodeThreadId(threadId);
    const text = this.toPlainText(message);

    const response = await this.request(
      `/v1/sessions/${encodeURIComponent(namespace)}/${encodeURIComponent(
        sessionKey
      )}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      }
    );

    const body = (await response.json()) as { message?: OpenClawMessage };
    const raw =
      body.message ??
      ({
        id: `local-${Date.now()}`,
        sessionKey,
        namespace,
        text,
      } satisfies OpenClawMessage);

    return {
      id: raw.id,
      threadId,
      raw,
    };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<OpenClawMessage>> {
    const { namespace, sessionKey } = this.decodeThreadId(threadId);
    const text = this.toPlainText(message);

    const response = await this.request(
      `/v1/sessions/${encodeURIComponent(namespace)}/${encodeURIComponent(
        sessionKey
      )}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ text }),
      }
    );

    const body = (await response.json()) as { message?: OpenClawMessage };
    const raw =
      body.message ??
      ({
        id: messageId,
        sessionKey,
        namespace,
        text,
        edited: true,
      } satisfies OpenClawMessage);

    return {
      id: raw.id,
      threadId,
      raw,
    };
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const { namespace, sessionKey } = this.decodeThreadId(threadId);
    await this.request(
      `/v1/sessions/${encodeURIComponent(namespace)}/${encodeURIComponent(
        sessionKey
      )}/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" }
    );
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    const { namespace, sessionKey } = this.decodeThreadId(threadId);
    await this.request(
      `/v1/sessions/${encodeURIComponent(namespace)}/${encodeURIComponent(
        sessionKey
      )}/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: "POST",
        body: JSON.stringify({ emoji: String(emoji) }),
      }
    );
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    const { namespace, sessionKey } = this.decodeThreadId(threadId);
    await this.request(
      `/v1/sessions/${encodeURIComponent(namespace)}/${encodeURIComponent(
        sessionKey
      )}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(String(emoji))}`,
      {
        method: "DELETE",
      }
    );
  }

  renderFormatted(content: FormattedContent): string {
    return markdownToPlainText(stringifyMarkdown(content));
  }

  async startTyping(_threadId: string, _status?: string): Promise<void> {
    // OpenClaw currently has no typing endpoint.
  }

  parseMessage(raw: OpenClawMessage): Message<OpenClawMessage> {
    const namespace = raw.namespace ?? this.defaultNamespace;
    const threadId = this.encodeThreadId({
      namespace,
      sessionKey: raw.sessionKey,
    });

    const text = raw.text ?? raw.content ?? "";
    const sentAt = raw.createdAt ? new Date(raw.createdAt) : new Date();
    const editedAt = raw.updatedAt ? new Date(raw.updatedAt) : undefined;
    const isMe = raw.role === "assistant";

    return new Message<OpenClawMessage>({
      id: raw.id,
      threadId,
      text,
      formatted: parseMarkdown(text),
      raw,
      author: {
        userId: raw.authorId ?? raw.role ?? "unknown",
        userName: raw.authorName ?? raw.role ?? "unknown",
        fullName: raw.authorName ?? raw.role ?? "Unknown",
        isBot: raw.role === "assistant",
        isMe,
      },
      metadata: {
        dateSent: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
        edited: raw.edited ?? Boolean(raw.updatedAt && raw.updatedAt !== raw.createdAt),
        editedAt:
          editedAt && !Number.isNaN(editedAt.getTime()) ? editedAt : undefined,
      },
      attachments: [],
    });
  }

  private toRawWebhookMessage(
    data: Record<string, unknown>,
    sessionKey: string,
    namespace: string
  ): OpenClawMessage {
    return {
      id: String(data.id ?? data.messageId ?? `evt-${Date.now()}`),
      sessionKey,
      namespace,
      role: this.toRole(data.role),
      text: String(data.text ?? data.content ?? ""),
      createdAt: String(data.createdAt ?? data.timestamp ?? new Date().toISOString()),
      updatedAt: data.updatedAt ? String(data.updatedAt) : undefined,
      authorId: data.authorId ? String(data.authorId) : undefined,
      authorName: data.authorName ? String(data.authorName) : undefined,
      raw: data,
    };
  }

  private toRole(value: unknown): "user" | "assistant" | "system" | undefined {
    if (value === "user" || value === "assistant" || value === "system") {
      return value;
    }
    return undefined;
  }

  private toPlainText(message: AdapterPostableMessage): string {
    if (typeof message === "string") return message;
    if ("raw" in message) return message.raw;
    if ("markdown" in message) return message.markdown;
    if ("ast" in message) return markdownToPlainText(stringifyMarkdown(message.ast));
    if ("card" in message) return message.fallbackText ?? "[card]";
    if (isCardElement(message)) return "[card]";
    return "";
  }

  private verifyWebhookSignature(request: Request, body: string): boolean {
    if (!this.webhookSecret) return true;

    const signature =
      request.headers.get("x-openclaw-signature") ??
      request.headers.get("x-webhook-signature");

    if (!signature) return false;

    const digest = createHmac("sha256", this.webhookSecret).update(body).digest("hex");
    const expected = Buffer.from(digest, "utf8");
    const actual = Buffer.from(signature.replace(/^sha256=/, ""), "utf8");

    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenClaw API ${response.status}: ${text || response.statusText}`);
    }

    return response;
  }
}
