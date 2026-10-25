import { afterEach, expect, test } from "bun:test";
import { HttpClient } from "../src/http-client";
import { fakeRetryTiming } from "./fake-retry-timing";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("preserves endpoint path for absolute API URLs", () => {
  const http = new HttpClient({ endpoint: "https://beta.typetype.video/api" });
  expect(http.absolute("/sabr/playback/session/manifest")).toBe(
    "https://beta.typetype.video/api/sabr/playback/session/manifest",
  );
});

test("retries transient gateway responses", async () => {
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    if (requests < 3) {
      return Promise.resolve(new Response(null, { status: 502, headers: { "retry-after": "0" } }));
    }
    return Promise.resolve(Response.json({ ready: true }));
  };

  const timing = fakeRetryTiming();

  const result = await new HttpClient({
    endpoint: "https://example.test/api",
    retryTiming: timing,
  }).json("/window");

  expect(result).toEqual({ ready: true });
  expect(requests).toBe(3);
  expect(timing.delays).toEqual([500, 1_000]);
});

test("does not retry permanent client errors", async () => {
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    return Promise.resolve(new Response(null, { status: 400, statusText: "Bad Request" }));
  };

  await expect(
    new HttpClient({ endpoint: "https://example.test/api" }).json("/window"),
  ).rejects.toMatchObject({ status: 400 });
  expect(requests).toBe(1);
});

test("returns segment statuses to the caller without retrying", async () => {
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    return Promise.resolve(new Response(null, { status: 503 }));
  };

  const exchange = await new HttpClient({ endpoint: "https://example.test/api" }).once(
    "https://example.test/segment",
  );

  expect(exchange.status).toBe(503);
  expect(requests).toBe(1);
});

test("bounds transient gateway retries by a total time budget", async () => {
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    return Promise.resolve(new Response(null, { status: 503, headers: { "retry-after": "0" } }));
  };
  const timing = fakeRetryTiming();

  await expect(
    new HttpClient({ endpoint: "https://example.test/api", retryTiming: timing }).json("/window"),
  ).rejects.toMatchObject({ status: 503 });
  expect(requests).toBe(11);
  expect(timing.delays.every((delayMs) => delayMs >= 500)).toBe(true);
  expect(timing.delays.reduce((total, delayMs) => total + delayMs, 0)).toBeLessThanOrEqual(60_000);
});

test("waits for the full Retry-After delay of an overloaded server", async () => {
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    if (requests === 1) {
      return Promise.resolve(new Response(null, { status: 503, headers: { "retry-after": "30" } }));
    }
    return Promise.resolve(Response.json({ ready: true }));
  };
  const timing = fakeRetryTiming();

  await new HttpClient({ endpoint: "https://example.test/api", retryTiming: timing }).json("/a");

  expect(timing.delays).toEqual([30_000]);
});

test("retries rate limited requests after an HTTP-date Retry-After", async () => {
  const timing = fakeRetryTiming(Date.parse("2026-10-25T12:00:00Z"));
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    if (requests === 1) {
      return Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { "retry-after": "Sun, 25 Oct 2026 12:00:12 GMT" },
        }),
      );
    }
    return Promise.resolve(Response.json({ ready: true }));
  };

  await new HttpClient({ endpoint: "https://example.test/api", retryTiming: timing }).json("/a");

  expect(requests).toBe(2);
  expect(timing.delays).toEqual([12_000]);
});

test("exposes the last Retry-After delay when transient retries run out", async () => {
  globalThis.fetch = () =>
    Promise.resolve(new Response(null, { status: 503, headers: { "retry-after": "45" } }));

  await expect(
    new HttpClient({ endpoint: "https://example.test/api", retryTiming: fakeRetryTiming() }).json(
      "/window",
    ),
  ).rejects.toMatchObject({ status: 503, retryAfterMs: 45_000 });
});

test("retries network failures with backoff", async () => {
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    if (requests < 3) return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve(Response.json({ ready: true }));
  };
  const timing = fakeRetryTiming();

  await new HttpClient({ endpoint: "https://example.test/api", retryTiming: timing }).json("/a");

  expect(timing.delays).toEqual([500, 1_000]);
});

test("aborts a pending transient retry", async () => {
  const controller = new AbortController();
  globalThis.fetch = () =>
    Promise.resolve(new Response(null, { status: 503, headers: { "retry-after": "3" } }));
  const request = new HttpClient({ endpoint: "https://example.test/api" }).json("/window", {
    signal: controller.signal,
  });

  controller.abort();

  await expect(request).rejects.toMatchObject({ name: "AbortError" });
});
