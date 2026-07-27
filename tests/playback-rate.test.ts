import { expect, test } from "bun:test";
import { rateAwareBufferGoalMs, StablePlaybackRate } from "../src/playback-rate";

test("tracks supported playback rates and ignores transient MSE rates", () => {
  const video = { playbackRate: 1 };
  const playbackRate = new StablePlaybackRate(video);

  video.playbackRate = 4;
  expect(playbackRate.current()).toBe(4);
  video.playbackRate = 16;
  expect(playbackRate.current()).toBe(4);
  video.playbackRate = 2;
  expect(playbackRate.current()).toBe(2);
});

test("scales the media buffer for fast playback with a bounded maximum", () => {
  expect(rateAwareBufferGoalMs(30_000, 1)).toBe(30_000);
  expect(rateAwareBufferGoalMs(30_000, 2)).toBe(60_000);
  expect(rateAwareBufferGoalMs(30_000, 4)).toBe(60_000);
  expect(rateAwareBufferGoalMs(8_000, 4)).toBe(32_000);
});
