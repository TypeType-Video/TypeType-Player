import { expect, test } from "bun:test";
import { runDecodePreroll } from "../src/decode-preroll";

const emptyBuffered = {
  length: 0,
  start: () => 0,
  end: () => 0,
} as TimeRanges;

test("restores a paused target after accelerated decode overshoots", async () => {
  let currentTime = 24.791;
  let paused = true;
  let writes = 0;
  const video = {
    autoplay: false,
    buffered: emptyBuffered,
    defaultPlaybackRate: 1,
    error: null,
    muted: false,
    playbackRate: 1,
    readyState: 4,
    seeking: false,
    style: { opacity: "" },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      writes += 1;
    },
    get paused() {
      return paused;
    },
    pause: () => {
      paused = true;
    },
    play: async () => {
      paused = false;
      currentTime = 32.8;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 30_298, false, new AbortController().signal);

  expect(writes).toBe(1);
  expect(video.currentTime).toBe(30.298);
  expect(video.paused).toBe(true);
});

test("snaps a paused target within the playback tolerance", async () => {
  let currentTime = 0.8;
  let paused = true;
  let writes = 0;
  const video = {
    autoplay: false,
    buffered: emptyBuffered,
    defaultPlaybackRate: 1,
    error: null,
    muted: false,
    playbackRate: 1,
    readyState: 4,
    seeking: false,
    style: { opacity: "" },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      writes += 1;
    },
    get paused() {
      return paused;
    },
    pause: () => {
      paused = true;
    },
    play: async () => {
      paused = false;
      currentTime = 0.982;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 1_034, false, new AbortController().signal);

  expect(writes).toBe(1);
  expect(video.currentTime).toBe(1.034);
  expect(video.paused).toBe(true);
});

test("restores and resumes a playing target after decode overshoots", async () => {
  let currentTime = 24.791;
  let paused = true;
  let plays = 0;
  const playRates: number[] = [];
  const video = {
    autoplay: false,
    buffered: emptyBuffered,
    defaultPlaybackRate: 1,
    error: null,
    muted: false,
    playbackRate: 1,
    readyState: 4,
    seeking: false,
    style: { opacity: "" },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
    },
    get paused() {
      return paused;
    },
    pause: () => {
      paused = true;
    },
    play: async () => {
      plays += 1;
      playRates.push(video.playbackRate);
      paused = false;
      if (plays === 1) currentTime = 32.8;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 30_298, true, new AbortController().signal);

  expect(plays).toBe(2);
  expect(playRates).toEqual([16, 1]);
  expect(video.currentTime).toBe(30.298);
  expect(video.paused).toBe(false);
});
