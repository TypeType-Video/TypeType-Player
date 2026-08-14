import { expect, test } from "bun:test";
import { runDecodePreroll } from "../src/decode-preroll";

const emptyBuffered = {
  length: 0,
  start: () => 0,
  end: () => 0,
} as TimeRanges;

test("decodes from the safe fragment start without a direct seek", async () => {
  let currentTime = 398.36;
  let currentTimeWrites = 0;
  let paused = true;
  let plays = 0;
  let pauses = 0;
  const rates: number[] = [];
  let playbackRate = 1;
  const video = {
    autoplay: false,
    buffered: emptyBuffered,
    error: null,
    muted: false,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      currentTimeWrites += 1;
    },
    get paused() {
      return paused;
    },
    get playbackRate() {
      return playbackRate;
    },
    set playbackRate(value: number) {
      playbackRate = value;
      rates.push(value);
    },
    readyState: 4,
    seeking: false,
    style: { opacity: "" },
    pause: () => {
      paused = true;
      pauses += 1;
    },
    play: async () => {
      paused = false;
      plays += 1;
      currentTime = 401.2;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 401_200, true, new AbortController().signal);

  expect(video.currentTime).toBe(401.2);
  expect(currentTimeWrites).toBe(0);
  expect(plays).toBe(1);
  expect(pauses).toBe(0);
  expect(rates).toContain(16);
  expect(video.muted).toBe(false);
});

test("pauses a running overshoot before snapping and resuming", async () => {
  let currentTime = 402;
  let paused = false;
  const events: string[] = [];
  const video = {
    autoplay: false,
    buffered: emptyBuffered,
    error: null,
    muted: false,
    playbackRate: 1,
    readyState: 4,
    seeking: false,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      events.push("seek");
      currentTime = value;
    },
    get paused() {
      return paused;
    },
    pause: () => {
      events.push("pause");
      paused = true;
    },
    play: async () => {
      events.push("play");
      paused = false;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 401_200, true, new AbortController().signal);

  expect(events).toEqual(["pause", "seek", "play"]);
  expect(video.currentTime).toBe(401.2);
  expect(video.paused).toBe(false);
});

test("uses a stable hidden decode preroll rate on WebKit", async () => {
  let currentTime = 398.36;
  let playbackRate = 1;
  let plays = 0;
  const rates: number[] = [];
  const currentTimeWrites: number[] = [];
  const style = { opacity: "0.75" };
  const video = {
    autoplay: false,
    buffered: emptyBuffered,
    defaultPlaybackRate: 1,
    error: null,
    muted: false,
    paused: false,
    readyState: 4,
    seeking: false,
    style,
    webkitSupportsFullscreen: false,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTimeWrites.push(value);
      currentTime = value;
    },
    get playbackRate() {
      return playbackRate;
    },
    set playbackRate(value: number) {
      playbackRate = value;
      rates.push(value);
    },
    pause: () => undefined,
    play: async () => {
      expect(style.opacity).toBe("0");
      plays += 1;
      currentTime = 401.2;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 401_200, true, new AbortController().signal);

  expect(plays).toBe(1);
  expect(currentTimeWrites).toEqual([]);
  expect(video.currentTime).toBe(401.2);
  expect(rates).toContain(1);
  expect(video.defaultPlaybackRate).toBe(1);
  expect(video.playbackRate).toBe(1);
  expect(video.muted).toBe(false);
  expect(style.opacity).toBe("0.75");
});
