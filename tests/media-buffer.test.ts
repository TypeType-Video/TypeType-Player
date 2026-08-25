import { expect, test } from "bun:test";
import {
  alignPlayheadToBufferedRange,
  bufferedEndAtCurrentTime,
  canUseBufferedMediaSeek,
  seekWithinBufferedMedia,
} from "../src/media-buffer";

test("uses the buffered range containing the playhead instead of the final range", () => {
  const video = media(
    [
      [0, 10],
      [40, 70],
    ],
    5,
  );

  expect(bufferedEndAtCurrentTime(video)).toBe(10_000);
  video.currentTime = 50;
  expect(bufferedEndAtCurrentTime(video)).toBe(70_000);
});

test("does not report media beyond a gap as buffered at the playhead", () => {
  expect(
    bufferedEndAtCurrentTime(
      media(
        [
          [0, 10],
          [40, 70],
        ],
        20,
      ),
    ),
  ).toBe(0);
});

test("seeks locally only when the target has enough buffered media", () => {
  const video = media(
    [
      [0, 30],
      [60, 90],
    ],
    5,
  );

  expect(seekWithinBufferedMedia(video, 20_000)).toBe(true);
  expect(video.currentTime).toBe(20);
  expect(seekWithinBufferedMedia(video, 45_000)).toBe(false);
  expect(seekWithinBufferedMedia(video, 89_900)).toBe(false);
});

test("uses the server seek path for WebKit media", () => {
  const video = Object.assign(media([[0, 30]], 5), {
    webkitSupportsFullscreen: false,
  });

  expect(canUseBufferedMediaSeek(video, 20_000)).toBe(false);
  expect(canUseBufferedMediaSeek(media([[0, 30]], 5), 20_000)).toBe(true);
});

test("moves a rounded playhead just inside a fractional buffer start", () => {
  const video = media([[527.493633, 549.151927]], 527.493);

  expect(alignPlayheadToBufferedRange(video)).toBe(true);
  expect(video.currentTime).toBeCloseTo(527.494633, 6);
});

test("keeps a playhead that is already inside the buffered range", () => {
  const video = media([[527.493633, 549.151927]], 527.5);

  expect(alignPlayheadToBufferedRange(video)).toBe(false);
  expect(video.currentTime).toBe(527.5);
});

function media(ranges: Array<[number, number]>, currentTime: number) {
  return {
    currentTime,
    buffered: {
      length: ranges.length,
      start: (index: number) => ranges[index]?.[0] ?? 0,
      end: (index: number) => ranges[index]?.[1] ?? 0,
    },
  } as HTMLVideoElement;
}
