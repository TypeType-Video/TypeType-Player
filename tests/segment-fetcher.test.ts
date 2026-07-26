import { afterEach, expect, test } from "bun:test";
import { HttpClient } from "../src/http-client";
import { PlaybackWindowRecoveryError } from "../src/playback-window-error";
import { fetchSegmentBytes } from "../src/segment-fetcher";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("polls retryable segment responses", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ retryAfterMs: 1 }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
  };
  globalThis.fetch = fetchMock;
  const bytes = await fetchSegmentBytes(
    new HttpClient({ endpoint: "https://example.com/api" }),
    "https://example.com/segment",
    5,
  );
  expect(calls).toBe(2);
  expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
});

test("turns an expired segment into fresh session recovery", async () => {
  globalThis.fetch = () => Promise.resolve(new Response(null, { status: 410 }));

  const request = fetchSegmentBytes(
    new HttpClient({ endpoint: "https://example.com/api" }),
    "https://example.com/segment",
    1,
  );
  const error = await request.catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(PlaybackWindowRecoveryError);
  expect(error).toMatchObject({ recoveryAction: "retry_fresh_session" });
});
