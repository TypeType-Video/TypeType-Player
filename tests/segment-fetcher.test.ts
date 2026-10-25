import { afterEach, expect, test } from "bun:test";
import { HttpClient } from "../src/http-client";
import {
  PlaybackWindowRecoveryError,
  SegmentGenerationConflictError,
} from "../src/playback-window-error";
import { fetchSegmentBytes } from "../src/segment-fetcher";
import { fakeRetryTiming } from "./fake-retry-timing";

const originalFetch = globalThis.fetch;
const http = new HttpClient({ endpoint: "https://example.com/api" });
const segmentUrl = "https://example.com/segment";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function pending(retryAfterMs: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify({ retryAfterMs }), {
    status: 202,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sequence(responses: Array<() => Response | Promise<Response>>): () => number {
  let calls = 0;
  globalThis.fetch = () => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return Promise.resolve(next ? next() : new Response(null, { status: 500 }));
  };
  return () => calls;
}

test("polls retryable segment responses", async () => {
  const calls = sequence([() => pending(1), () => new Response(new Uint8Array([1, 2, 3]))]);
  const timing = fakeRetryTiming();

  const bytes = await fetchSegmentBytes(http, segmentUrl, 5, undefined, timing);

  expect(calls()).toBe(2);
  expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
  expect(timing.delays).toEqual([250]);
});

test("turns an expired segment into fresh session recovery", async () => {
  sequence([() => new Response(null, { status: 410 })]);

  const error = await fetchSegmentBytes(http, segmentUrl, 1).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(PlaybackWindowRecoveryError);
  expect(error).toMatchObject({ recoveryAction: "retry_fresh_session" });
});

test("turns a segment poll timeout into fresh session recovery", async () => {
  sequence([() => pending(0)]);

  const error = await fetchSegmentBytes(http, segmentUrl, 1).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(PlaybackWindowRecoveryError);
  expect(error).toMatchObject({
    message: "SABR segment was not ready in time",
    recoveryAction: "retry_fresh_session",
  });
});

test("retries server errors on the same segment instead of failing playback", async () => {
  const calls = sequence([
    () => new Response(null, { status: 500 }),
    () => new Response(null, { status: 502 }),
    () => new Response(new Uint8Array([7])),
  ]);
  const timing = fakeRetryTiming();

  const bytes = await fetchSegmentBytes(http, segmentUrl, 5, undefined, timing);

  expect([...new Uint8Array(bytes)]).toEqual([7]);
  expect(calls()).toBe(3);
  expect(timing.delays).toEqual([500, 1_000]);
});

test("waits for the Retry-After delay of a rate limited segment", async () => {
  sequence([
    () => new Response(null, { status: 429, headers: { "retry-after": "5" } }),
    () => new Response(new Uint8Array([1])),
  ]);
  const timing = fakeRetryTiming();

  await fetchSegmentBytes(http, segmentUrl, 5, undefined, timing);

  expect(timing.delays).toEqual([5_000]);
});

test("retries network and body read failures", async () => {
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) return Promise.reject(new TypeError("Failed to fetch"));
    if (calls === 2) {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new TypeError("network error"));
            },
          }),
        ),
      );
    }
    return Promise.resolve(new Response(new Uint8Array([4])));
  };

  const bytes = await fetchSegmentBytes(http, segmentUrl, 5, undefined, fakeRetryTiming());

  expect(calls).toBe(3);
  expect([...new Uint8Array(bytes)]).toEqual([4]);
});

test("asks for a fresh session at the current position once the retry budget runs out", async () => {
  const calls = sequence([
    () => new Response(null, { status: 503, headers: { "retry-after": "20" } }),
  ]);

  const error = await fetchSegmentBytes(http, segmentUrl, 5, undefined, fakeRetryTiming()).catch(
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(PlaybackWindowRecoveryError);
  expect(error).toMatchObject({ recoveryAction: "retry_fresh_session", retryAfterMs: 20_000 });
  expect(calls()).toBe(4);
});

test("honours an HTTP-date Retry-After while a segment is pending", async () => {
  const timing = fakeRetryTiming(Date.parse("2026-10-25T12:00:00Z"));
  sequence([
    () => pending(0, { "retry-after": "Sun, 25 Oct 2026 12:00:03 GMT" }),
    () => new Response(new Uint8Array([1])),
  ]);

  await fetchSegmentBytes(http, segmentUrl, 5, undefined, timing);

  expect(timing.delays).toEqual([3_000]);
});

test("aborts a pending segment poll immediately", async () => {
  sequence([() => pending(30_000)]);
  const controller = new AbortController();

  const request = fetchSegmentBytes(http, segmentUrl, 5, controller.signal);
  await Bun.sleep(5);
  controller.abort();

  await expect(request).rejects.toMatchObject({ name: "AbortError" });
});

test("reports a stale generation so the caller can refresh segment URLs", async () => {
  const calls = sequence([() => new Response(null, { status: 409 })]);

  const error = await fetchSegmentBytes(http, segmentUrl, 5).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(SegmentGenerationConflictError);
  expect(calls()).toBe(1);
});
