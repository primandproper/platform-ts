import { randomUUID } from "node:crypto";

import { wrap } from "@primandproper/errors";
import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { Redis } from "ioredis";

import type {
  Message,
  MessageHandler,
  MessageQueue,
  OutgoingMessage,
  Subscription,
} from "../messagequeue.js";

export interface RedisMessageQueueOptions {
  url: string;
  /** Prepended to every topic to namespace its stream key. */
  keyPrefix?: string;
  /** How long each blocking read parks waiting for new messages, in milliseconds. */
  blockMs?: number;
  /** Maximum number of messages pulled per read. */
  batchSize?: number;
}

const o11yName = "messagequeue";

const DEFAULT_BLOCK_MS = 5_000;
const DEFAULT_BATCH_SIZE = 16;
const ERROR_BACKOFF_MS = 1_000;

/** XREADGROUP reply: one entry per stream, each carrying a list of `[id, [field, value, …]]`. */
type StreamReply = [stream: string, entries: [id: string, fields: string[]][]][] | null;

/**
 * Node-only provider backed by Redis Streams (ioredis). Each topic maps to a stream; `publish`
 * is an `XADD`. Every {@link subscribe} call creates its own consumer group starting at `$`, so
 * subscribers each receive a copy of messages published after they subscribe — the same fan-out
 * the memory provider gives, but durable and cross-process. Reads block on a dedicated duplicated
 * connection and `XACK` only after the handler resolves; a throwing handler leaves the message
 * pending (visible in the group's PEL) rather than dropping it. Server-side only.
 */
export class RedisMessageQueue implements MessageQueue {
  readonly #client: Redis;
  readonly #prefix: string;
  readonly #blockMs: number;
  readonly #batchSize: number;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: RedisMessageQueueOptions, deps: ObservabilityDeps = {}) {
    this.#client = new Redis(options.url, { lazyConnect: true });
    this.#prefix = options.keyPrefix ?? "";
    this.#blockMs = options.blockMs ?? DEFAULT_BLOCK_MS;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async publish(topic: string, message: OutgoingMessage): Promise<void> {
    const id = message.id ?? randomUUID();
    const fields = ["id", id, "body", message.body];
    if (message.attributes !== undefined) {
      fields.push("attributes", JSON.stringify(message.attributes));
    }

    try {
      await this.#client.xadd(this.#key(topic), "*", ...fields);
    } catch (err) {
      throw wrap(`messagequeue: failed to publish to ${topic} on redis`, err);
    }
  }

  async subscribe(topic: string, handler: MessageHandler): Promise<Subscription> {
    const key = this.#key(topic);
    const group = `mq:${randomUUID()}`;

    try {
      // MKSTREAM creates the stream when absent; `$` starts the group at messages published
      // from here on, mirroring the memory provider's subscribe-then-deliver semantics.
      await this.#client.xgroup("CREATE", key, group, "$", "MKSTREAM");
    } catch (err) {
      throw wrap(
        `messagequeue: failed to create consumer group for ${topic} on redis`,
        err,
      );
    }

    const reader = this.#client.duplicate();
    let active = true;
    const runner = this.#readLoop(reader, key, group, handler, () => active);

    const unsubscribe = async (): Promise<void> => {
      if (!active) {
        return;
      }
      active = false;
      reader.disconnect(); // interrupts the in-flight blocking read
      await runner;
      try {
        await this.#client.xgroup("DESTROY", key, group);
      } catch (err) {
        this.#logger.error(
          "messagequeue: failed to destroy consumer group on redis",
          err,
        );
      }
    };

    return { unsubscribe };
  }

  async ping(): Promise<void> {
    try {
      await this.#client.ping();
    } catch (err) {
      throw wrap("messagequeue: redis ping failed", err);
    }
  }

  async #readLoop(
    reader: Redis,
    key: string,
    group: string,
    handler: MessageHandler,
    isActive: () => boolean,
  ): Promise<void> {
    while (isActive()) {
      let reply: StreamReply;
      try {
        reply = (await reader.xreadgroup(
          "GROUP",
          group,
          "consumer",
          "COUNT",
          this.#batchSize,
          "BLOCK",
          this.#blockMs,
          "STREAMS",
          key,
          ">",
        )) as StreamReply;
      } catch (err) {
        if (!isActive()) {
          break; // disconnect() during unsubscribe; expected
        }
        this.#logger.error("messagequeue: redis read loop failed; retrying", err);
        await delay(ERROR_BACKOFF_MS);
        continue;
      }

      if (reply === null) {
        continue; // block timeout, nothing new
      }

      for (const [, entries] of reply) {
        for (const [entryId, fields] of entries) {
          const message = parseMessage(fields);
          try {
            await handler(message);
            await reader.xack(key, group, entryId);
          } catch (err) {
            this.#logger.error(
              "messagequeue: handler failed; leaving message pending",
              err,
            );
          }
        }
      }
    }
  }

  #key(topic: string): string {
    return this.#prefix + topic;
  }
}

/** Rebuilds a {@link Message} from a stream entry's flat `[field, value, …]` array. */
function parseMessage(fields: string[]): Message {
  const record: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const field = fields[i];
    const value = fields[i + 1];
    if (field !== undefined && value !== undefined) {
      record[field] = value;
    }
  }

  const message: Message = {
    id: record.id ?? "",
    body: record.body ?? "",
  };
  if (record.attributes !== undefined) {
    message.attributes = JSON.parse(record.attributes) as Record<string, string>;
  }
  return message;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
