import { expect, test } from "bun:test";
import { parseRetryAfterMs, RetryBudget, retryDelayMs } from "../src/retry-backoff";
import { fakeRetryTiming } from "./fake-retry-timing";

test("doubles the backoff from half a second up to eight seconds", () => {
  expect([0, 1, 2, 3, 4, 5, 8].map((attempt) => retryDelayMs(attempt, null, 0))).toEqual([
    500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
  ]);
});

test("never retries sooner than the server asked or than a quarter second", () => {
  expect(retryDelayMs(0, 0, 0)).toBe(500);
  expect(retryDelayMs(0, 30_000, 0)).toBe(30_000);
  expect(retryDelayMs(0, 90_000, 0)).toBe(60_000);
});

test("adds bounded jitter on top of the delay", () => {
  expect(retryDelayMs(1, null, 0.5)).toBe(1_100);
  expect(retryDelayMs(0, 10_000, 0.999)).toBeLessThanOrEqual(12_000);
});

test("parses Retry-After seconds and HTTP dates", () => {
  const nowMs = Date.parse("2026-10-25T12:00:00Z");

  expect(parseRetryAfterMs("3", nowMs)).toBe(3_000);
  expect(parseRetryAfterMs(" 0 ", nowMs)).toBe(0);
  expect(parseRetryAfterMs("Sun, 25 Oct 2026 12:00:05 GMT", nowMs)).toBe(5_000);
  expect(parseRetryAfterMs("Sun, 25 Oct 2026 11:59:00 GMT", nowMs)).toBe(0);
  expect(parseRetryAfterMs("-1", nowMs)).toBeNull();
  expect(parseRetryAfterMs("soon", nowMs)).toBeNull();
  expect(parseRetryAfterMs(null, nowMs)).toBeNull();
});

test("stops waiting once the next delay would exceed the budget", async () => {
  const timing = fakeRetryTiming();
  const budget = new RetryBudget(timing, 5_000);

  const results = [
    await budget.wait(null),
    await budget.wait(null),
    await budget.wait(null),
    await budget.wait(null),
  ];

  expect(results).toEqual([true, true, true, false]);
  expect(timing.delays).toEqual([500, 1_000, 2_000]);
});
