import { afterEach, describe, expect, it, vi } from "vitest";

import { BeaconSink, BEACON_REJECTED_CODE, SINK_CLOSED_CODE } from "./beacon.browser.js";

const URL_ = "https://collect.example/capture";

/** Captures every POST the sink makes, so tests can assert batching rather than transport. */
function stubFetch(status = 200): { calls: { body: unknown; init: RequestInit }[] } {
  const calls: { body: unknown; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", (_input: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(init.body as string), init });
    return Promise.resolve(new Response(null, { status }));
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BeaconSink", () => {
  it("batches records and POSTs them as one array on flush", async () => {
    const { calls } = stubFetch();
    const sink = new BeaconSink({ url: URL_ });

    await sink.write({ a: 1 });
    await sink.write({ a: 2 });
    // Batching is the point: nothing goes out per record.
    expect(calls).toHaveLength(0);
    expect(sink.pending).toBe(2);

    await sink.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual([{ a: 1 }, { a: 2 }]);
    expect(calls[0]?.init.keepalive).toBe(true);
  });

  it("sends without waiting once the batch is full", async () => {
    const { calls } = stubFetch();
    const sink = new BeaconSink({ url: URL_, maxBatch: 2 });

    await sink.write({ a: 1 });
    await sink.write({ a: 2 });

    expect(calls).toHaveLength(1);
    expect(sink.pending).toBe(0);
  });

  it("attaches the configured headers", async () => {
    const { calls } = stubFetch();
    const sink = new BeaconSink({ url: URL_, headers: { authorization: "Bearer t" } });

    await sink.write({ a: 1 });
    await sink.flush();

    expect(calls[0]?.init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer t",
    });
  });

  it("does not POST an empty batch", async () => {
    const { calls } = stubFetch();
    const sink = new BeaconSink({ url: URL_ });

    await sink.flush();
    await sink.close();

    expect(calls).toHaveLength(0);
  });

  it("reports a rejecting endpoint so the recorder can count it", async () => {
    stubFetch(503);
    const sink = new BeaconSink({ url: URL_ });

    await sink.write({ a: 1 });
    await expect(sink.flush()).rejects.toMatchObject({ code: BEACON_REJECTED_CODE });
  });

  it("prefers sendBeacon for the tail, where fetch may never be dispatched", async () => {
    const { calls } = stubFetch();
    const beacons: { url: string; size: number }[] = [];
    vi.stubGlobal("navigator", {
      sendBeacon: (url: string, blob: Blob) => {
        beacons.push({ url, size: blob.size });
        return true;
      },
    });
    const sink = new BeaconSink({ url: URL_ });

    await sink.write({ a: 1 });
    await sink.close();

    expect(beacons).toHaveLength(1);
    expect(beacons[0]?.url).toBe(URL_);
    expect(calls).toHaveLength(0);
  });

  it("falls back to fetch when the browser refuses the beacon", async () => {
    const { calls } = stubFetch();
    vi.stubGlobal("navigator", { sendBeacon: () => false });
    const sink = new BeaconSink({ url: URL_ });

    await sink.write({ a: 1 });
    await sink.close();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual([{ a: 1 }]);
  });

  it("refuses records after close", async () => {
    stubFetch();
    const sink = new BeaconSink({ url: URL_ });

    await sink.close();
    await expect(sink.write({ a: 1 })).rejects.toMatchObject({ code: SINK_CLOSED_CODE });
  });
});
