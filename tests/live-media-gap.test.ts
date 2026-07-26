import { expect, test } from "bun:test";
import { skipBufferedLiveGap } from "../src/live-media-gap";

test("skips a small live gap into the next buffered range", () => {
  const video = media(
    [
      [10, 20],
      [25, 35],
    ],
    20,
  );

  expect(skipBufferedLiveGap(video)).toBe(true);
  expect(video.currentTime).toBeCloseTo(25.01);
});

test("accepts live timestamp rounding at the server recovery boundary", () => {
  const video = media([[35.013, 40]], 20);

  expect(skipBufferedLiveGap(video)).toBe(true);
  expect(video.currentTime).toBeCloseTo(35.023);
});

test("follows a bounded stale live window without replacing playback", () => {
  const video = media([[55, 65]], 20);

  expect(skipBufferedLiveGap(video)).toBe(true);
  expect(video.currentTime).toBeCloseTo(55.01);
});

test("does not skip while media is paused or still buffered", () => {
  const paused = media([[25, 35]], 20, true);
  const buffered = media([[10, 25]], 20);

  expect(skipBufferedLiveGap(paused)).toBe(false);
  expect(paused.currentTime).toBe(20);
  expect(skipBufferedLiveGap(buffered)).toBe(false);
  expect(buffered.currentTime).toBe(20);
});

test("does not hide an unbounded discontinuity or an unusable range", () => {
  const large = media([[90, 100]], 20);
  const tiny = media([[25, 25.1]], 20);

  expect(skipBufferedLiveGap(large)).toBe(false);
  expect(skipBufferedLiveGap(tiny)).toBe(false);
});

function media(
  ranges: Array<[number, number]>,
  currentTime: number,
  paused = false,
): HTMLVideoElement {
  return {
    currentTime,
    paused,
    buffered: {
      length: ranges.length,
      start: (index: number) => ranges[index]?.[0] ?? 0,
      end: (index: number) => ranges[index]?.[1] ?? 0,
    },
  } as HTMLVideoElement;
}
