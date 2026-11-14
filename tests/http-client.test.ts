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

test("evaluates dynamic headers on each request and refreshes once on 401", async () => {
  let token = "expired-token";
  const authHeaders: Array<string | null> = [];
  let refreshes = 0;

  globalThis.fetch = (_input, init) => {
    const auth = new Headers(init?.headers).get("authorization");
    authHeaders.push(auth);
    if (auth === "Bearer fresh-token") {
      return Promise.resolve(Response.json({ ready: true }));
    }
    return Promise.resolve(new Response(null, { status: 401, statusText: "Unauthorized" }));
  };

  const result = await new HttpClient({
    endpoint: "https://example.test/api",
    getHeaders: () => ({ authorization: `Bearer ${token}` }),
    onUnauthorized: async () => {
      refreshes += 1;
      token = "fresh-token";
      return true;
    },
  }).json("/window");

  expect(result).toEqual({ ready: true });
  expect(refreshes).toBe(1);
  expect(authHeaders).toEqual(["Bearer expired-token", "Bearer fresh-token"]);
});

test("fails fast on repeated 401 without looping or transient backoff", async () => {
  let requests = 0;
  let refreshes = 0;
  const timing = fakeRetryTiming();

  globalThis.fetch = () => {
    requests += 1;
    return Promise.resolve(new Response(null, { status: 401, statusText: "Unauthorized" }));
  };

  await expect(
    new HttpClient({
      endpoint: "https://example.test/api",
      retryTiming: timing,
      onUnauthorized: async () => {
        refreshes += 1;
        return true;
      },
    }).json("/window"),
  ).rejects.toMatchObject({ status: 401 });

  expect(requests).toBe(2);
  expect(refreshes).toBe(1);
  expect(timing.delays).toEqual([]);
});

test("refreshes 401 responses once for once() segment exchanges too", async () => {
  let token = "stale";
  globalThis.fetch = (_input, init) => {
    const auth = new Headers(init?.headers).get("authorization");
    if (auth === "Bearer valid") {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    }
    return Promise.resolve(new Response(null, { status: 401, statusText: "Unauthorized" }));
  };

  const exchange = await new HttpClient({
    endpoint: "https://example.test/api",
    getHeaders: () => ({ authorization: `Bearer ${token}` }),
    onUnauthorized: async () => {
      token = "valid";
    },
  }).once("https://example.test/segment");

  expect(exchange.status).toBe(200);
  expect(new Uint8Array(exchange.body)).toEqual(new Uint8Array([1, 2, 3]));
});

test("passes the attempted request headers to onUnauthorized", async () => {
  const seenAuthHeaders: Array<string | null> = [];
  let token: string | null = "attempt-token";
  globalThis.fetch = (_input, init) => {
    const auth = new Headers(init?.headers).get("authorization");
    if (auth === "Bearer fresh-token") {
      return Promise.resolve(Response.json({ ok: true }));
    }
    return Promise.resolve(new Response(null, { status: 401, statusText: "Unauthorized" }));
  };

  const result = await new HttpClient({
    endpoint: "https://example.test/api",
    getHeaders: () => (token ? { authorization: `Bearer ${token}` } : undefined),
    onUnauthorized: async (_status, requestHeaders) => {
      seenAuthHeaders.push(requestHeaders.get("authorization"));
      token = "fresh-token";
      return true;
    },
  }).json("/window");

  expect(result).toEqual({ ok: true });
  expect(seenAuthHeaders).toEqual(["Bearer attempt-token"]);
});
