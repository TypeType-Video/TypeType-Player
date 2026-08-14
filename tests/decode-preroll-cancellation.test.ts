import { expect, test } from "bun:test";
import { runDecodePreroll } from "../src/decode-preroll";

const emptyBuffered = {
  length: 0,
  start: () => 0,
  end: () => 0,
} as TimeRanges;

test("rejects an abort that happens at the exact preroll target", async () => {
  let currentTime = 24.791;
  const controller = new AbortController();
  const video = {
    autoplay: false,
    buffered: emptyBuffered,
    error: null,
    muted: false,
    playbackRate: 1,
    readyState: 4,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
    },
    pause: () => controller.abort(),
    play: async () => {
      currentTime = 30.298;
    },
  } as unknown as HTMLVideoElement;

  await expect(runDecodePreroll(video, 30_298, false, controller.signal)).rejects.toHaveProperty(
    "name",
    "AbortError",
  );
});

test("rejects an abort during a resumed target play", async () => {
  const controller = new AbortController();
  const video = {
    autoplay: false,
    currentTime: 30.25,
    error: null,
    muted: false,
    paused: true,
    playbackRate: 1,
    readyState: 4,
    pause: () => undefined,
    play: async () => controller.abort(),
  } as unknown as HTMLVideoElement;

  await expect(runDecodePreroll(video, 30_298, true, controller.signal)).rejects.toHaveProperty(
    "name",
    "AbortError",
  );
});
