import { expect, test } from "bun:test";
import { decodeStartMs, runDecodePreroll } from "../src/decode-preroll";
import type { PlaybackManifest } from "../src/manifest";

const emptyBuffered = {
  length: 0,
  start: () => 0,
  end: () => 0,
} as TimeRanges;

const manifest: PlaybackManifest = {
  durationMs: 3_554_292,
  endOfStream: false,
  audio: {
    kind: "audio",
    mime: 'audio/mp4; codecs="mp4a.40.2"',
    initUrl: "/140/init",
    segments: [
      { url: "/140/40", startMs: 389_398, durationMs: 9_985 },
      { url: "/140/41", startMs: 399_383, durationMs: 9_985 },
    ],
  },
  video: {
    kind: "video",
    mime: 'video/mp4; codecs="avc1.640028"',
    initUrl: "/137/init",
    segments: [
      { url: "/137/78", startMs: 398_360, durationMs: 3_360 },
      { url: "/137/79", startMs: 401_720, durationMs: 6_840 },
    ],
  },
};

test("starts audiovisual decode from the video sync segment", () => {
  expect(decodeStartMs(manifest, 401_200)).toBe(398_360);
});

test("starts directly on an exact audio fragment boundary", () => {
  expect(decodeStartMs(manifest, 399_383)).toBe(399_383);
});

test("keeps the target when no video segment contains it", () => {
  expect(decodeStartMs(manifest, 500_000)).toBe(500_000);
});

test("keeps the target for audio-only manifests", () => {
  expect(decodeStartMs({ ...manifest, video: null }, 401_200)).toBe(401_200);
});

test("decodes a paused frame at an existing target", async () => {
  let currentTime = 207.599;
  let plays = 0;
  let pauses = 0;
  let paused = true;
  let readyState = 1;
  const video = {
    autoplay: false,
    buffered: emptyBuffered,
    error: null,
    muted: false,
    playbackRate: 1,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      readyState = 2;
    },
    get readyState() {
      return readyState;
    },
    get paused() {
      return paused;
    },
    pause: () => {
      paused = true;
      pauses += 1;
    },
    play: async () => {
      paused = false;
      plays += 1;
      readyState = 2;
    },
  } as unknown as HTMLVideoElement;
  await runDecodePreroll(video, 207_599, false, new AbortController().signal, true);
  expect(plays).toBe(1);
  expect(pauses).toBe(1);
  expect(video.muted).toBe(false);
  expect(video.playbackRate).toBe(1);
});

test("snaps an overshot decoded frame to the exact target", async () => {
  let plays = 0;
  const video = {
    autoplay: false,
    buffered: emptyBuffered,
    currentTime: 442.178,
    error: null,
    muted: false,
    playbackRate: 1,
    readyState: 4,
    pause: () => undefined,
    play: async () => {
      plays += 1;
    },
  } as unknown as HTMLVideoElement;
  await runDecodePreroll(video, 438_698, true, new AbortController().signal);
  expect(video.currentTime).toBe(438.698);
  expect(plays).toBe(0);
});

test("decodes from the safe start before resuming", async () => {
  let currentTime = 24.791;
  let currentTimeWrites = 0;
  let paused = true;
  let plays = 0;
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
    get paused() {
      return paused;
    },
    set currentTime(value: number) {
      currentTime = value;
      currentTimeWrites += 1;
    },
    pause: () => {
      paused = true;
    },
    play: async () => {
      plays += 1;
      paused = false;
      currentTime = 30.298;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 30_298, true, new AbortController().signal);

  expect(plays).toBe(1);
  expect(currentTimeWrites).toBe(0);
  expect(video.currentTime).toBe(30.298);
});

test("keeps a resumed position already within target tolerance", async () => {
  let currentTime = 30.25;
  let currentTimeWrites = 0;
  let plays = 0;
  const video = {
    autoplay: false,
    buffered: emptyBuffered,
    error: null,
    muted: false,
    paused: true,
    playbackRate: 1,
    readyState: 4,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      currentTimeWrites += 1;
    },
    pause: () => undefined,
    play: async () => {
      plays += 1;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 30_298, true, new AbortController().signal);

  expect(currentTimeWrites).toBe(0);
  expect(plays).toBe(1);
});

test("keeps a decoded target when automatic resume needs a gesture", async () => {
  const error = new Error("User interaction is required");
  error.name = "NotAllowedError";
  const video = {
    autoplay: false,
    buffered: emptyBuffered,
    currentTime: 30.25,
    error: null,
    muted: false,
    paused: true,
    playbackRate: 1,
    readyState: 4,
    pause: () => undefined,
    play: async () => {
      throw error;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 30_298, true, new AbortController().signal);
  expect(video.currentTime).toBe(30.25);
});

test("decodes to the target before resuming", async () => {
  let currentTime = 24.791;
  let currentTimeWrites = 0;
  let paused = true;
  let plays = 0;
  let pauses = 0;
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
    get paused() {
      return paused;
    },
    set currentTime(value: number) {
      currentTime = value;
      currentTimeWrites += 1;
    },
    pause: () => {
      pauses += 1;
      paused = true;
    },
    play: async () => {
      plays += 1;
      paused = false;
      currentTime = 30.298;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 30_298, true, new AbortController().signal);

  expect(currentTimeWrites).toBe(0);
  expect(pauses).toBe(0);
  expect(plays).toBe(1);
});

test("snaps a naturally decoded paused frame to the exact target", async () => {
  let currentTime = 24.791;
  let currentTimeWrites = 0;
  let pauses = 0;
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
      currentTimeWrites += 1;
    },
    pause: () => {
      pauses += 1;
    },
    play: async () => {
      currentTime = 30.23;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 30_298, false, new AbortController().signal);

  expect(currentTimeWrites).toBe(1);
  expect(pauses).toBe(1);
  expect(video.currentTime).toBe(30.298);
});
