import { describe, expect, test } from "bun:test";
import { bufferSeconds, resolvePlaybackPolicy } from "../src/playback-policy";

describe("playback policy", () => {
  test("uses low-latency defaults from Xtra and the existing web player", () => {
    const policy = resolvePlaybackPolicy();

    expect(policy).toEqual({
      startupBufferMs: 2_000,
      steadyBufferMs: 24_000,
      maxBufferMs: 50_000,
      backBufferMs: 30_000,
      manifestRefreshMs: 1_000,
      manifestAttempts: 5,
      mediaAttempts: 3,
      retryIntervalMs: 500,
      liveTargetLatencyMs: 2_000,
      liveMaxLatencyMs: 15_000,
      liveCatchupMinRate: 1,
      liveCatchupMaxRate: 1.25,
    });
    expect(bufferSeconds(policy.startupBufferMs)).toBe(2);
  });

  test("clamps dependent buffer and live-catch-up values", () => {
    const policy = resolvePlaybackPolicy({
      steadyBufferMs: 60_000,
      maxBufferMs: 30_000,
      liveTargetLatencyMs: 20_000,
      liveMaxLatencyMs: 10_000,
      liveCatchupMaxRate: 1,
      liveCatchupMinRate: 1.25,
    });

    expect(policy.steadyBufferMs).toBe(30_000);
    expect(policy.liveTargetLatencyMs).toBe(10_000);
    expect(policy.liveCatchupMaxRate).toBe(1.25);
  });

  test("rejects invalid timing and attempts", () => {
    expect(resolvePlaybackPolicy({ startupBufferMs: 0 }).startupBufferMs).toBe(2_000);
    expect(resolvePlaybackPolicy({ manifestAttempts: 1.5 }).manifestAttempts).toBe(5);
    expect(resolvePlaybackPolicy({ mediaAttempts: -1 }).mediaAttempts).toBe(3);
  });
});
