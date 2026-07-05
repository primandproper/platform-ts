import { describe, expect, it, vi } from "vitest";

import { KafkaConsumerProvider } from "../index.js";

type EachMessage = (arg: {
  topic: string;
  partition: number;
  message: { value: Buffer; offset: string };
}) => Promise<void>;

const h = vi.hoisted(() => ({
  eachMessage: undefined as EachMessage | undefined,
  commitOffsets: vi.fn<(offsets: unknown) => Promise<void>>(() => Promise.resolve()),
  disconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

/** Fires the CRASH event kafkajs would emit on a consumer crash. */
const crash = (error: unknown, restart: boolean): void => {
  h.listeners.get("consumer.crash")?.({ payload: { error, restart } });
};

vi.mock("kafkajs", () => {
  const consumer = {
    connect: () => Promise.resolve(),
    subscribe: () => Promise.resolve(),
    run: (opts: { eachMessage: EachMessage }) => {
      h.eachMessage = opts.eachMessage;
      return Promise.resolve();
    },
    commitOffsets: h.commitOffsets,
    disconnect: h.disconnect,
    events: { CRASH: "consumer.crash", DISCONNECT: "consumer.disconnect" },
    on: (event: string, cb: (event: { payload: unknown }) => void) => {
      h.listeners.set(event, cb);
      return () => h.listeners.delete(event);
    },
  };
  class Kafka {
    consumer(): typeof consumer {
      return consumer;
    }
    producer(): unknown {
      return {};
    }
    admin(): unknown {
      return { connect: () => Promise.resolve(), disconnect: () => Promise.resolve() };
    }
  }
  return { Kafka };
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const deliver = (topic: string, partition: number, offset: string): Promise<void> => {
  if (!h.eachMessage) {
    throw new Error("eachMessage not registered");
  }
  return h.eachMessage({
    topic,
    partition,
    message: { value: Buffer.from("{}"), offset },
  });
};

describe("KafkaConsumer offset safety (MQ-1)", () => {
  it("does not commit past a failed message", async () => {
    const boom = new Error("handler failed");
    let calls = 0;
    const handler = (): Promise<void> => {
      calls += 1;
      return calls === 1 ? Promise.reject(boom) : Promise.resolve();
    };

    const provider = new KafkaConsumerProvider({ brokers: ["broker"], groupId: "g" });
    const errors: unknown[] = [];
    const consumer = await provider.provideConsumer("topic", handler);

    const stop = new AbortController();
    void consumer.consume(stop.signal, (err) => errors.push(err));
    await tick();

    // First delivery of offset 5 fails: eachMessage rejects so kafkajs won't advance, and nothing
    // is committed.
    await expect(deliver("topic", 0, "5")).rejects.toBe(boom);
    expect(h.commitOffsets).not.toHaveBeenCalled();
    expect(errors).toEqual([boom]);

    // Redelivery of the SAME offset succeeds and commits 6 — never a later offset that would have
    // skipped past 5.
    await deliver("topic", 0, "5");
    expect(h.commitOffsets).toHaveBeenCalledTimes(1);
    expect(h.commitOffsets).toHaveBeenCalledWith([
      { topic: "topic", partition: 0, offset: "6" },
    ]);

    stop.abort();
  });
});

describe("KafkaConsumer death visibility (LC-9)", () => {
  it("surfaces a fatal crash through onError and resolves consume()", async () => {
    h.disconnect.mockClear();
    const provider = new KafkaConsumerProvider({ brokers: ["broker"], groupId: "g" });
    const consumer = await provider.provideConsumer("topic", () => Promise.resolve());

    const errors: unknown[] = [];
    const done = consumer.consume(new AbortController().signal, (err) =>
      errors.push(err),
    );
    await tick(); // let connect/subscribe/run settle and register the crash listener

    const boom = new Error("non-retriable");
    crash(boom, false);

    await expect(done).resolves.toBeUndefined(); // no longer hangs forever
    expect(errors).toEqual([boom]);
    expect(h.disconnect).toHaveBeenCalled();
  });

  it("surfaces a retriable crash through onError but keeps consuming", async () => {
    h.disconnect.mockClear();
    const provider = new KafkaConsumerProvider({ brokers: ["broker"], groupId: "g" });
    const consumer = await provider.provideConsumer("topic2", () => Promise.resolve());

    const errors: unknown[] = [];
    const stop = new AbortController();
    void consumer.consume(stop.signal, (err) => errors.push(err));
    await tick();

    crash(new Error("transient"), true);

    expect(errors).toHaveLength(1);
    expect(h.disconnect).not.toHaveBeenCalled(); // restart=true must not tear the reader down
    stop.abort();
  });
});

describe("KafkaConsumerProvider close (LC-4)", () => {
  it("disconnects cached consumers on close", async () => {
    h.disconnect.mockClear();
    const provider = new KafkaConsumerProvider({ brokers: ["broker"], groupId: "g" });
    await provider.provideConsumer("topic3", () => Promise.resolve());

    await provider.close();

    expect(h.disconnect).toHaveBeenCalled();
  });
});
