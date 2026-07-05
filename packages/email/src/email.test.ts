import {
  makeRecordingObserver,
  type MeterProvider,
  type ObservabilityDeps,
} from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import { EmptyEmailBodyError, type Email, type EmailMessage } from "./email.js";
import type { FetchLike } from "./providers/http.js";
import { MailgunEmail } from "./providers/mailgun.js";
import { MailjetEmail } from "./providers/mailjet.js";
import { MemoryEmail } from "./providers/memory.js";
import { NoopEmail } from "./providers/noop.js";
import {
  PostmarkEmail,
  type PostmarkClientLike,
  type PostmarkMessage,
  type PostmarkSendResponse,
} from "./providers/postmark.node.js";
import { ResendEmail } from "./providers/resend.js";
import { SendgridEmail } from "./providers/sendgrid.js";

import { provideEmail } from "./index.js";

const sample: EmailMessage = {
  to: "to@example.com",
  from: "from@example.com",
  subject: "hello",
  text: "hi there",
};

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple
 * providers proves the `Email` interface is implementation-independent.
 */
function conformance(name: string, make: () => Email): void {
  describe(name, () => {
    it("sends without throwing", async () => {
      await expect(make().send(sample)).resolves.toBeDefined();
    });

    it("pings without throwing", async () => {
      await expect(make().ping()).resolves.toBeUndefined();
    });

    it("rejects a message with no text or html body", async () => {
      await expect(
        make().send({ to: "a@b.com", from: "c@d.com", subject: "x" }),
      ).rejects.toBeInstanceOf(EmptyEmailBodyError);
    });
  });
}

/** A Postmark client that records sends and returns a canned response, no network. */
function fakePostmarkClient(response: PostmarkSendResponse = { MessageID: "pm_stub" }): {
  client: PostmarkClientLike;
  sent: PostmarkMessage[];
} {
  const sent: PostmarkMessage[] = [];
  const client: PostmarkClientLike = {
    sendEmail(message) {
      sent.push(message);
      return Promise.resolve(response);
    },
    getServer() {
      return Promise.resolve({});
    },
  };
  return { client, sent };
}

conformance("NoopEmail", () => new NoopEmail());
conformance("MemoryEmail", () => new MemoryEmail());
conformance(
  "PostmarkEmail",
  () => new PostmarkEmail({ serverToken: "tok", client: fakePostmarkClient().client }),
);

describe("MemoryEmail", () => {
  it("captures every sent message", async () => {
    const email = new MemoryEmail();

    await email.send(sample);
    await email.send({ ...sample, subject: "second" });

    expect(email.sent).toHaveLength(2);
    expect(email.sent[0]?.subject).toBe("hello");
    expect(email.sent[1]?.subject).toBe("second");
    expect(email.sent[0]?.to).toBe("to@example.com");
  });
});

/** A MeterProvider that records every counter `add`, so tests can assert send/error counters. */
function countingMeter(): { deps: ObservabilityDeps; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const meter = {
    createCounter: (name: string) => ({
      add: (value: number) => counts.set(name, (counts.get(name) ?? 0) + value),
    }),
    // makeObserver auto-mints an operation-duration histogram; the fake meter must provide
    // it even though these tests only assert on the counters.
    createHistogram: () => ({ record: () => undefined }),
    createUpDownCounter: () => ({ add: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  const provider = { getMeter: () => meter } as unknown as MeterProvider;
  return { deps: { metrics: provider }, counts };
}

/** Builds a fake `fetch` that records its call and returns the given response. */
function fakeFetch(response: Response): {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(response);
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ResendEmail", () => {
  it("POSTs to the emails endpoint with the bearer token", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ id: "re_123" }));
    const email = new ResendEmail({ apiKey: "key_abc", fetch });

    const result = await email.send(sample);

    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer key_abc");
    expect(result.id).toBe("re_123");
  });

  it("serializes the message into the request body", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ id: "re_1" }));
    const email = new ResendEmail({ apiKey: "k", fetch });

    await email.send({ ...sample, html: "<p>hi</p>", replyTo: "reply@example.com" });

    const body = JSON.parse(calls[0]?.init.body as string) as {
      to: string;
      from: string;
      subject: string;
      text: string;
      html: string;
      reply_to: string;
    };
    expect(body.to).toBe("to@example.com");
    expect(body.from).toBe("from@example.com");
    expect(body.subject).toBe("hello");
    expect(body.text).toBe("hi there");
    expect(body.html).toBe("<p>hi</p>");
    expect(body.reply_to).toBe("reply@example.com");
  });

  it("honors a custom base URL", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ id: "re_1" }));
    const email = new ResendEmail({
      apiKey: "k",
      baseUrl: "https://resend.internal",
      fetch,
    });

    await email.send(sample);

    expect(calls[0]?.url).toBe("https://resend.internal/emails");
  });

  it("returns an empty result when the response omits an id", async () => {
    const { fetch } = fakeFetch(jsonResponse({}));
    const email = new ResendEmail({ apiKey: "k", fetch });

    expect(await email.send(sample)).toStrictEqual({});
  });

  it("does not throw on a 2xx with an empty or non-JSON body (EM-1)", async () => {
    const empty = fakeFetch(new Response("", { status: 200 }));
    await expect(
      new ResendEmail({ apiKey: "k", fetch: empty.fetch }).send(sample),
    ).resolves.toStrictEqual({});

    const nonJson = fakeFetch(new Response("OK", { status: 200 }));
    await expect(
      new ResendEmail({ apiKey: "k", fetch: nonJson.fetch }).send(sample),
    ).resolves.toStrictEqual({});
  });

  it("pings a real authenticated endpoint (GET /domains), not OPTIONS /emails (EM-1)", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ data: [] }));
    await new ResendEmail({ apiKey: "k", fetch }).ping();

    expect(calls[0]?.url).toBe("https://api.resend.com/domains");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("throws with status and body on a non-ok response", async () => {
    const { fetch } = fakeFetch(new Response("bad request", { status: 422 }));
    const email = new ResendEmail({ apiKey: "k", fetch });

    await expect(email.send(sample)).rejects.toThrow(/422.*bad request/);
  });

  it("falls back to globalThis.fetch when none is injected", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: "re_global" }));
    const email = new ResendEmail({ apiKey: "k" });

    const result = await email.send(sample);

    expect(result.id).toBe("re_global");
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe("PostmarkEmail", () => {
  it("maps the message into Postmark's PascalCase fields", async () => {
    const { client, sent } = fakePostmarkClient({ MessageID: "pm_1" });
    const email = new PostmarkEmail({ serverToken: "tok", client });

    const result = await email.send({
      ...sample,
      to: ["a@example.com", "b@example.com"],
      html: "<p>hi</p>",
      cc: "cc@example.com",
      replyTo: "reply@example.com",
    });

    expect(sent[0]?.From).toBe("from@example.com");
    expect(sent[0]?.To).toBe("a@example.com, b@example.com");
    expect(sent[0]?.Subject).toBe("hello");
    expect(sent[0]?.TextBody).toBe("hi there");
    expect(sent[0]?.HtmlBody).toBe("<p>hi</p>");
    expect(sent[0]?.Cc).toBe("cc@example.com");
    expect(sent[0]?.ReplyTo).toBe("reply@example.com");
    expect(result.id).toBe("pm_1");
  });

  it("returns an empty result when the response omits a MessageID", async () => {
    const { client } = fakePostmarkClient({});
    const email = new PostmarkEmail({ serverToken: "tok", client });

    expect(await email.send(sample)).toStrictEqual({});
  });

  it("throws with the error code and message on a non-zero ErrorCode", async () => {
    const { client } = fakePostmarkClient({ ErrorCode: 300, Message: "Invalid email" });
    const email = new PostmarkEmail({ serverToken: "tok", client });

    await expect(email.send(sample)).rejects.toThrow(/300.*Invalid email/);
  });

  it("wraps an error thrown by the SDK", async () => {
    const client: PostmarkClientLike = {
      sendEmail() {
        return Promise.reject(new Error("network down"));
      },
      getServer() {
        return Promise.resolve({});
      },
    };
    const email = new PostmarkEmail({ serverToken: "tok", client });

    await expect(email.send(sample)).rejects.toThrow(
      /postmark send failed: network down/,
    );
  });
});

describe("SendgridEmail", () => {
  it("POSTs to the mail send endpoint and reads the message-id header", async () => {
    const { fetch, calls } = fakeFetch(
      new Response(null, { status: 202, headers: { "x-message-id": "sg_1" } }),
    );
    const email = new SendgridEmail({ apiKey: "SG.key", fetch });

    const result = await email.send({
      ...sample,
      html: "<p>hi</p>",
      cc: "cc@example.com",
      replyTo: "r@example.com",
    });

    expect(calls[0]?.url).toBe("https://api.sendgrid.com/v3/mail/send");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer SG.key");
    const body = JSON.parse(calls[0]?.init.body as string) as {
      personalizations: { to: { email: string }[]; cc: { email: string }[] }[];
      from: { email: string };
      content: { type: string; value: string }[];
      reply_to: { email: string };
    };
    expect(body.personalizations[0]?.to).toStrictEqual([{ email: "to@example.com" }]);
    expect(body.personalizations[0]?.cc).toStrictEqual([{ email: "cc@example.com" }]);
    expect(body.from).toStrictEqual({ email: "from@example.com" });
    expect(body.content).toStrictEqual([
      { type: "text/plain", value: "hi there" },
      { type: "text/html", value: "<p>hi</p>" },
    ]);
    expect(body.reply_to).toStrictEqual({ email: "r@example.com" });
    expect(result.id).toBe("sg_1");
  });

  it("rejects a message with no body", async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 202 }));
    await expect(
      new SendgridEmail({ apiKey: "k", fetch }).send({
        to: "a@b.com",
        from: "c@d.com",
        subject: "x",
      }),
    ).rejects.toBeInstanceOf(EmptyEmailBodyError);
  });

  it("throws with status and body on a non-ok response", async () => {
    const { fetch } = fakeFetch(new Response("bad", { status: 400 }));
    await expect(new SendgridEmail({ apiKey: "k", fetch }).send(sample)).rejects.toThrow(
      /400.*bad/,
    );
  });
});

describe("MailgunEmail", () => {
  it("POSTs a form body with basic auth and reads the id", async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse({ id: "<mg_1@d>", message: "Queued" }),
    );
    const email = new MailgunEmail({
      apiKey: "key-abc",
      domain: "mg.example.com",
      fetch,
    });

    const result = await email.send({
      ...sample,
      cc: ["c1@x.com", "c2@x.com"],
      replyTo: "r@example.com",
    });

    expect(calls[0]?.url).toBe("https://api.mailgun.net/v3/mg.example.com/messages");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa("api:key-abc")}`);
    const form = new URLSearchParams(calls[0]?.init.body as string);
    expect(form.get("from")).toBe("from@example.com");
    expect(form.get("to")).toBe("to@example.com");
    expect(form.get("subject")).toBe("hello");
    expect(form.get("text")).toBe("hi there");
    expect(form.getAll("cc")).toStrictEqual(["c1@x.com", "c2@x.com"]);
    expect(form.get("h:Reply-To")).toBe("r@example.com");
    expect(result.id).toBe("<mg_1@d>");
  });

  it("honors the EU base URL", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ id: "x" }));
    await new MailgunEmail({
      apiKey: "k",
      domain: "d",
      baseUrl: "https://api.eu.mailgun.net",
      fetch,
    }).send(sample);
    expect(calls[0]?.url).toBe("https://api.eu.mailgun.net/v3/d/messages");
  });
});

describe("MailjetEmail", () => {
  it("POSTs the Messages payload with basic auth and reads the message uuid", async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse({ Messages: [{ To: [{ MessageID: 123, MessageUUID: "uuid-1" }] }] }),
    );
    const email = new MailjetEmail({ apiKey: "ak", secretKey: "sk", fetch });

    const result = await email.send({ ...sample, html: "<p>hi</p>" });

    expect(calls[0]?.url).toBe("https://api.mailjet.com/v3.1/send");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa("ak:sk")}`);
    const body = JSON.parse(calls[0]?.init.body as string) as {
      Messages: {
        From: { Email: string };
        To: { Email: string }[];
        TextPart: string;
        HTMLPart: string;
      }[];
    };
    expect(body.Messages[0]?.From).toStrictEqual({ Email: "from@example.com" });
    expect(body.Messages[0]?.To).toStrictEqual([{ Email: "to@example.com" }]);
    expect(body.Messages[0]?.TextPart).toBe("hi there");
    expect(body.Messages[0]?.HTMLPart).toBe("<p>hi</p>");
    expect(result.id).toBe("uuid-1");
  });

  it("falls back to the numeric MessageID when no uuid is present", async () => {
    const { fetch } = fakeFetch(
      jsonResponse({ Messages: [{ To: [{ MessageID: 99 }] }] }),
    );
    const result = await new MailjetEmail({ apiKey: "a", secretKey: "s", fetch }).send(
      sample,
    );
    expect(result.id).toBe("99");
  });

  it("does not throw on a 2xx with an empty or non-JSON body (EM-1)", async () => {
    const { fetch } = fakeFetch(new Response("", { status: 200 }));
    await expect(
      new MailjetEmail({ apiKey: "a", secretKey: "s", fetch }).send(sample),
    ).resolves.toStrictEqual({});
  });
});

describe("email instrumentation", () => {
  it("counts the send and records the recipient domain and request id on success", async () => {
    const { deps, counts } = countingMeter();
    const observer = makeRecordingObserver();
    const { fetch } = fakeFetch(jsonResponse({ id: "re_ok" }));
    const email = new ResendEmail({ apiKey: "k", fetch }, { ...deps, observer });

    await email.send(sample);

    expect(counts.get("email_sends")).toBe(1);
    expect(observer.observations).toContainEqual(
      expect.objectContaining({ key: "recipientDomain", value: "example.com" }),
    );
    expect(observer.observations).toContainEqual(
      expect.objectContaining({ key: "requestId", value: "re_ok" }),
    );
  });

  it("counts the error and logs the recipient domain and request id on failure", async () => {
    const { deps, counts } = countingMeter();
    const observer = makeRecordingObserver();
    const { fetch } = fakeFetch(
      new Response("boom", { status: 500, headers: { "x-request-id": "req_err" } }),
    );
    const email = new ResendEmail({ apiKey: "k", fetch }, { ...deps, observer });

    await expect(email.send(sample)).rejects.toThrow(/500.*boom/);

    expect(counts.get("email_errors")).toBe(1);
    expect(observer.observations).toContainEqual(
      expect.objectContaining({ key: "recipientDomain", value: "example.com" }),
    );
    expect(observer.observations).toContainEqual(
      expect.objectContaining({ key: "requestId", value: "req_err" }),
    );
    expect(observer.errors.map((e) => e.description)).toContain(
      "resend send failed with status 500",
    );
  });

  it("passes the cause to the logger when the postmark SDK throws", async () => {
    const { deps, counts } = countingMeter();
    const observer = makeRecordingObserver();
    const client: PostmarkClientLike = {
      sendEmail() {
        return Promise.reject(new Error("network down"));
      },
      getServer() {
        return Promise.resolve({});
      },
    };
    const email = new PostmarkEmail(
      { serverToken: "tok", client },
      { ...deps, observer },
    );

    await expect(email.send(sample)).rejects.toThrow(/network down/);

    expect(counts.get("email_errors")).toBe(1);
    const recorded = observer.errors[0];
    expect(recorded?.description).toBe("postmark send failed");
    expect((recorded?.err as Error).message).toMatch(/network down/);
    expect(observer.observations).toContainEqual(
      expect.objectContaining({ key: "recipientDomain", value: "example.com" }),
    );
  });
});

describe("email resilience (timeout + retry)", () => {
  it("passes an abort signal into the send fetch by default (timeout on)", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ id: "re_ok" }));
    const email = new ResendEmail({ apiKey: "k", fetch });

    await email.send(sample);

    const signal = calls[0]?.init.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("sends no signal when the timeout is disabled", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ id: "re_ok" }));
    const email = new ResendEmail({ apiKey: "k", timeoutMs: 0, fetch });

    await email.send(sample);

    expect(calls[0]?.init.signal ?? undefined).toBeUndefined();
  });

  it("does not retry by default", async () => {
    let attempts = 0;
    const fetch: FetchLike = () => {
      attempts += 1;
      return Promise.resolve(new Response("boom", { status: 503 }));
    };
    const email = new ResendEmail({ apiKey: "k", fetch });

    await expect(email.send(sample)).rejects.toThrow(/503/);
    expect(attempts).toBe(1);
  });

  it("retries a 503 when a retry policy is configured, then surfaces the final response", async () => {
    let attempts = 0;
    const fetch: FetchLike = () => {
      attempts += 1;
      return Promise.resolve(new Response("still down", { status: 503 }));
    };
    const email = new ResendEmail({
      apiKey: "k",
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: 0,
        maxElapsedMs: 0,
      },
      fetch,
    });

    await expect(email.send(sample)).rejects.toThrow(/503.*still down/);
    // Three attempts, then the final 503 surfaces through the provider's own error path.
    expect(attempts).toBe(3);
  });

  it("does not retry a 4xx even when a retry policy is configured", async () => {
    let attempts = 0;
    const fetch: FetchLike = () => {
      attempts += 1;
      return Promise.resolve(new Response("bad request", { status: 400 }));
    };
    const email = new ResendEmail({
      apiKey: "k",
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: 0,
        maxElapsedMs: 0,
      },
      fetch,
    });

    await expect(email.send(sample)).rejects.toThrow(/400/);
    expect(attempts).toBe(1);
  });

  it("retries a transient network error, then succeeds", async () => {
    let attempts = 0;
    const fetch: FetchLike = () => {
      attempts += 1;
      return attempts < 2
        ? Promise.reject(new Error("ECONNRESET"))
        : Promise.resolve(jsonResponse({ id: "re_ok" }));
    };
    const email = new ResendEmail({
      apiKey: "k",
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: 0,
        maxElapsedMs: 0,
      },
      fetch,
    });

    const result = await email.send(sample);
    expect(result.id).toBe("re_ok");
    expect(attempts).toBe(2);
  });
});

describe("provideEmail", () => {
  it("defaults to the noop provider", () => {
    expect(provideEmail()).toBeInstanceOf(NoopEmail);
  });

  it("builds a memory provider", () => {
    expect(provideEmail({ provider: "memory" })).toBeInstanceOf(MemoryEmail);
  });

  it("builds a resend provider", () => {
    const email = provideEmail({ provider: "resend", resend: { apiKey: "k" } });
    expect(email).toBeInstanceOf(ResendEmail);
  });

  it("rejects a resend provider without config", () => {
    expect(() => provideEmail({ provider: "resend" })).toThrow();
  });

  it("builds a postmark provider", () => {
    const email = provideEmail({
      provider: "postmark",
      postmark: { serverToken: "tok" },
    });
    expect(email).toBeInstanceOf(PostmarkEmail);
  });

  it("rejects a postmark provider without config", () => {
    expect(() => provideEmail({ provider: "postmark" })).toThrow();
  });

  it("builds the REST providers from config", () => {
    expect(
      provideEmail({ provider: "sendgrid", sendgrid: { apiKey: "k" } }),
    ).toBeInstanceOf(SendgridEmail);
    expect(
      provideEmail({ provider: "mailgun", mailgun: { apiKey: "k", domain: "d" } }),
    ).toBeInstanceOf(MailgunEmail);
    expect(
      provideEmail({ provider: "mailjet", mailjet: { apiKey: "k", secretKey: "s" } }),
    ).toBeInstanceOf(MailjetEmail);
  });

  it("rejects the REST providers without config", () => {
    expect(() => provideEmail({ provider: "sendgrid" })).toThrow();
    expect(() => provideEmail({ provider: "mailgun" })).toThrow();
    expect(() => provideEmail({ provider: "mailjet" })).toThrow();
  });
});
