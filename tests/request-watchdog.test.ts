import { afterEach, expect, test } from "bun:test";
import { HttpClient } from "../src/http-client";
import {
  API_REQUEST_WATCHDOG,
  MEDIA_REQUEST_WATCHDOG,
  RequestStallError,
} from "../src/request-watchdog";
import { fakeRetryTiming } from "./fake-retry-timing";

const originalFetch = globalThis.fetch;
const watchdog = { firstByteMs: 40, idleMs: 30 };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("abandons a request that never answers and retries it", async () => {
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    if (requests === 1) return new Promise<Response>(() => undefined);
    return Promise.resolve(Response.json({ ready: true }));
  };
  const http = new HttpClient({
    endpoint: "https://example.test/api",
    retryTiming: fakeRetryTiming(),
    watchdog,
  });

  await expect(http.json("/window")).resolves.toEqual({ ready: true });
  expect(requests).toBe(2);
});

test("reports a body that stops streaming as a stall", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
          },
        }),
      ),
    );
  const http = new HttpClient({ endpoint: "https://example.test/api", watchdog });

  const error = await http.once("https://example.test/segment").catch((reason) => reason);

  expect(error).toBeInstanceOf(RequestStallError);
});

test("keeps a slow body alive while chunks keep arriving", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let index = 0; index < 5; index += 1) {
              await Bun.sleep(15);
              controller.enqueue(new Uint8Array([index]));
            }
            controller.close();
          },
        }),
      ),
    );
  const http = new HttpClient({ endpoint: "https://example.test/api", watchdog });

  const exchange = await http.once("https://example.test/segment");

  expect([...new Uint8Array(exchange.body)]).toEqual([0, 1, 2, 3, 4]);
});

test("reports a caller abort instead of a stall", async () => {
  const controller = new AbortController();
  globalThis.fetch = () => new Promise<Response>(() => undefined);
  const http = new HttpClient({ endpoint: "https://example.test/api", watchdog });

  const request = http.once("https://example.test/segment", { signal: controller.signal });
  controller.abort();

  await expect(request).rejects.toMatchObject({ name: "AbortError" });
});

test("gives session API requests more time to answer than media segments", () => {
  expect(MEDIA_REQUEST_WATCHDOG).toEqual({ firstByteMs: 30_000, idleMs: 15_000 });
  expect(API_REQUEST_WATCHDOG.firstByteMs).toBeGreaterThanOrEqual(60_000);
});
