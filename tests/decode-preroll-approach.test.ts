import { afterEach, expect, test } from "bun:test";
import { runDecodePreroll } from "../src/decode-preroll";

const realSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
});

function lateTimerVideo(startSeconds: number, lateFactor: number) {
  let positionMs = startSeconds * 1000;
  let playbackRate = 1;
  let paused = true;
  const writes: number[] = [];
  globalThis.setTimeout = ((handler: () => void, delayMs?: number) => {
    if (!paused) positionMs += (delayMs ?? 0) * lateFactor * playbackRate;
    queueMicrotask(handler);
    return 0;
  }) as unknown as typeof setTimeout;
  const video = {
    autoplay: false,
    buffered: { length: 1, start: () => 0, end: () => 600 },
    defaultPlaybackRate: 1,
    error: null,
    muted: false,
    readyState: 4,
    seeking: false,
    style: { opacity: "" },
    get playbackRate() {
      return playbackRate;
    },
    set playbackRate(value: number) {
      playbackRate = value;
    },
    get currentTime() {
      return positionMs / 1000;
    },
    set currentTime(value: number) {
      writes.push(value);
      positionMs = value * 1000;
    },
    get paused() {
      return paused;
    },
    pause: () => {
      paused = true;
    },
    play: async () => {
      paused = false;
    },
  } as unknown as HTMLVideoElement;
  return { video, writes };
}

test("an accelerated preroll lands on the target instead of jumping back", async () => {
  const { video, writes } = lateTimerVideo(28.38, 3);

  await runDecodePreroll(video, 30_000, true, new AbortController().signal);

  expect(writes).toEqual([]);
  expect(Math.abs(video.currentTime * 1000 - 30_000)).toBeLessThanOrEqual(80);
  expect(video.paused).toBe(false);
  expect(video.playbackRate).toBe(1);
});
