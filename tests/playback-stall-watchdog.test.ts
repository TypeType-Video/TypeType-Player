import { expect, test } from "bun:test";
import { PlaybackStallWatchdog } from "../src/playback-stall-watchdog";

function media(ranges: Array<[number, number]>, currentTime: number) {
  return Object.assign(new EventTarget(), {
    currentTime,
    paused: false,
    seeking: false,
    ended: false,
    readyState: 2,
    buffered: {
      length: ranges.length,
      start: (index: number) => ranges[index]?.[0] ?? 0,
      end: (index: number) => ranges[index]?.[1] ?? 0,
    },
  });
}

function watchdog(video: ReturnType<typeof media>, busy = false) {
  let nowMs = 0;
  let tick: () => void = () => undefined;
  const subject = new PlaybackStallWatchdog({
    video: video as unknown as HTMLVideoElement,
    busy: () => busy,
    now: () => nowMs,
    every: (callback) => {
      tick = callback;
      return () => undefined;
    },
  });
  subject.start();
  const advance = (ms: number) => {
    nowMs += ms;
    tick();
  };
  return { subject, advance };
}

test("jumps a small VOD buffer gap when playback starts waiting", () => {
  const video = media(
    [
      [0, 10],
      [10.4, 30],
    ],
    10,
  );
  watchdog(video);

  video.dispatchEvent(new Event("waiting"));

  expect(video.currentTime).toBeCloseTo(10.41, 5);
});

test("leaves large gaps to the segment scheduler", () => {
  const video = media(
    [
      [0, 10],
      [12, 30],
    ],
    10,
  );
  watchdog(video);

  video.dispatchEvent(new Event("waiting"));

  expect(video.currentTime).toBe(10);
});

test("nudges playback that is stuck with media buffered ahead", () => {
  const video = media([[0, 30]], 12);
  video.readyState = 4;
  const { advance } = watchdog(video);

  advance(500);
  advance(1_500);
  expect(video.currentTime).toBe(12);
  advance(1_500);

  expect(video.currentTime).toBeCloseTo(12.1, 5);
});

test("does not nudge while the player owns a transition", () => {
  const video = media([[0, 30]], 12);
  const { advance } = watchdog(video, true);

  advance(500);
  advance(5_000);
  video.dispatchEvent(new Event("waiting"));

  expect(video.currentTime).toBe(12);
});

test("does not nudge a paused element or one without media ahead", () => {
  const paused = media([[0, 30]], 12);
  paused.paused = true;
  const starved = media([[0, 12.2]], 12);
  const first = watchdog(paused);
  const second = watchdog(starved);

  for (const step of [500, 3_000, 3_000]) {
    first.advance(step);
    second.advance(step);
  }

  expect(paused.currentTime).toBe(12);
  expect(starved.currentTime).toBe(12);
});
