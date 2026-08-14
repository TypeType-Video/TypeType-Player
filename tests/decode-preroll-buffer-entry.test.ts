import { expect, test } from "bun:test";
import { runDecodePreroll } from "../src/decode-preroll";

test("enters a fractional buffered range before decoding", async () => {
  let currentTime = 527.493;
  let paused = true;
  let readyState = 1;
  let plays = 0;
  let writes = 0;
  const video = {
    autoplay: false,
    buffered: {
      length: 1,
      start: () => 527.493633,
      end: () => 549.151927,
    },
    error: null,
    muted: false,
    playbackRate: 1,
    get readyState() {
      return readyState;
    },
    get currentTime() {
      if (!paused && currentTime >= 527.493633) currentTime = 529.95;
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      paused = true;
      readyState = 4;
      writes += 1;
    },
    get paused() {
      return paused;
    },
    pause: () => {
      paused = true;
    },
    play: async () => {
      plays += 1;
      paused = false;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 529_972, false, new AbortController().signal, true);

  expect(writes).toBe(1);
  expect(plays).toBe(1);
  expect(video.currentTime).toBeCloseTo(529.95, 2);
  expect(video.paused).toBe(true);
});

test("starts decode when bytes are buffered before a frame is ready", async () => {
  let currentTime = 79.346;
  let paused = true;
  let readyState = 1;
  let plays = 0;
  const video = {
    autoplay: false,
    buffered: {
      length: 1,
      start: () => 79.345,
      end: () => 115.281,
    } as TimeRanges,
    error: null,
    muted: false,
    playbackRate: 1,
    get currentTime() {
      return currentTime;
    },
    get paused() {
      return paused;
    },
    get readyState() {
      return readyState;
    },
    pause: () => {
      paused = true;
    },
    play: async () => {
      plays += 1;
      paused = false;
      readyState = 4;
      currentTime = 89.97;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 89_970, true, new AbortController().signal);

  expect(plays).toBe(1);
  expect(video.currentTime).toBe(89.97);
});
