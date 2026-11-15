import { expect, test } from "bun:test";
import { AdaptiveRefreshThreshold } from "../src/adaptive-refresh-threshold";

test("keeps default 6.67s VOD threshold under low RTT and raises lead safely within 10s goal under high RTT", () => {
  const adaptive = new AdaptiveRefreshThreshold();
  expect(adaptive.thresholdMs(10_000, false)).toBe(6_667);

  adaptive.observeControlRtt(150);
  adaptive.observeControlRtt(220);
  expect(adaptive.thresholdMs(10_000, false)).toBe(6_667);

  adaptive.observeControlRtt(1_200);
  const elevated = adaptive.thresholdMs(10_000, false);
  expect(elevated).toBeGreaterThan(6_667);
  expect(elevated).toBeLessThanOrEqual(9_000);
  expect(adaptive.thresholdMs(10_000, true)).toBe(6_667);

  adaptive.observeControlRtt(250);
  adaptive.observeControlRtt(260);
  adaptive.observeControlRtt(250);
  expect(adaptive.thresholdMs(10_000, false)).toBe(elevated);

  for (let i = 0; i < 10; i += 1) {
    adaptive.observeControlRtt(250);
  }
  expect(adaptive.thresholdMs(10_000, false)).toBe(6_667);
});
