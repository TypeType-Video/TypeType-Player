import { expect, spyOn, test } from "bun:test";
import { runDecodePreroll } from "../src/decode-preroll";

test("seeks directly without exposing accelerated decode", async () => {
  let currentTime = 398.36;
  let paused = true;
  let plays = 0;
  let pauses = 0;
  const rates: number[] = [];
  let playbackRate = 1;
  const video = {
    autoplay: false,
    error: null,
    muted: false,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
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
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 401_200, true, new AbortController().signal);

  expect(video.currentTime).toBe(401.2);
  expect(plays).toBe(1);
  expect(pauses).toBe(0);
  expect(rates).not.toContain(16);
  expect(video.muted).toBe(false);
});

test("pauses a running overshoot before snapping and resuming", async () => {
  let currentTime = 402;
  let paused = false;
  const events: string[] = [];
  const video = {
    autoplay: false,
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

test("waits for the browser seek to finish before resuming", async () => {
  let currentTime = 398.36;
  let paused = true;
  let seeking = false;
  let plays = 0;
  const seekingWhenPlayed: boolean[] = [];
  const video = {
    autoplay: false,
    error: null,
    muted: false,
    playbackRate: 1,
    readyState: 4,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      seeking = true;
      setTimeout(() => {
        seeking = false;
      }, 20);
    },
    get paused() {
      return paused;
    },
    get seeking() {
      return seeking;
    },
    pause: () => {
      paused = true;
    },
    play: async () => {
      seekingWhenPlayed.push(seeking);
      paused = false;
      plays += 1;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 401_200, true, new AbortController().signal);

  expect(plays).toBe(1);
  expect(seekingWhenPlayed).toEqual([true]);
  expect(video.currentTime).toBe(401.2);
});

test("keeps paused playback at the direct target", async () => {
  let currentTime = 398.36;
  let pauses = 0;
  const video = {
    autoplay: false,
    error: null,
    muted: false,
    paused: true,
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
    pause: () => {
      pauses += 1;
    },
    play: async () => {
      throw new Error("direct paused seek must not play");
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 401_200, false, new AbortController().signal, true);

  expect(video.currentTime).toBe(401.2);
  expect(pauses).toBe(1);
  expect(video.playbackRate).toBe(1);
  expect(video.muted).toBe(false);
});

test("falls back to bounded accelerated decode after a direct seek timeout", async () => {
  let currentTime = 398.36;
  let paused = true;
  let plays = 0;
  const rates: number[] = [];
  let playbackRate = 1;
  const now = spyOn(performance, "now");
  let nowCalls = 0;
  now.mockImplementation(() => (nowCalls++ === 0 ? 0 : 3_000));
  const video = {
    autoplay: false,
    defaultPlaybackRate: 1,
    error: null,
    muted: false,
    readyState: 4,
    seeking: false,
    style: { opacity: "" },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      if (value === 398.36) currentTime = value;
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
    pause: () => {
      paused = true;
    },
    play: async () => {
      paused = false;
      plays += 1;
      if (plays > 1) currentTime = 401.2;
    },
  } as unknown as HTMLVideoElement;

  try {
    await runDecodePreroll(video, 401_200, true, new AbortController().signal);
  } finally {
    now.mockRestore();
  }

  expect(plays).toBe(2);
  expect(rates).toContain(16);
  expect(video.playbackRate).toBe(1);
  expect(video.muted).toBe(false);
  expect(video.style.opacity).toBe("");
  expect(video.currentTime).toBe(401.2);
});

test("uses hidden decode preroll on WebKit without attempting a direct seek", async () => {
  let currentTime = 398.36;
  let playbackRate = 1;
  let plays = 0;
  const currentTimeWrites: number[] = [];
  const style = { opacity: "0.75" };
  const video = {
    autoplay: false,
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
  expect(video.playbackRate).toBe(1);
  expect(video.muted).toBe(false);
  expect(style.opacity).toBe("0.75");
});
