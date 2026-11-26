import { expect, test } from "bun:test";
import type { EventEmitter } from "../src/event-emitter";
import type { HttpClient, HttpExchange } from "../src/http-client";
import type { PlaybackManifest } from "../src/manifest";
import type { MediaBufferedRange, MediaSourceController } from "../src/media-source-controller";
import type { PlaybackWindow } from "../src/playback-window";
import { PlaybackRecovery } from "../src/player-recovery";
import { loadPlayerSession } from "../src/player-session-loader";
import { SegmentScheduler } from "../src/segment-scheduler";
import { skipRecoveryDelay } from "./fake-retry-timing";

Object.defineProperty(globalThis, "MediaSource", {
  value: { isTypeSupported: (mime: string) => mime.length > 0 },
  configurable: true,
});

const manifest: PlaybackManifest = {
  durationMs: 120_000,
  endOfStream: false,
  audio: {
    kind: "audio",
    mime: 'audio/mp4; codecs="mp4a.40.2"',
    initUrl: "/audio/init",
    segments: [{ url: "/audio/1", startMs: 0, durationMs: 5_000 }],
  },
  video: {
    kind: "video",
    mime: 'video/mp4; codecs="avc1.640028"',
    initUrl: "/video/init",
    segments: [{ url: "/video/1", startMs: 0, durationMs: 5_000 }],
  },
};

function window(sessionId: string, generation: number | null): PlaybackWindow {
  return {
    sessionId,
    generation,
    ready: true,
    retryAfterMs: null,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    manifest,
  };
}

function load(fill: () => Promise<"filled">, bufferedRanges: () => MediaBufferedRange[]) {
  return loadPlayerSession({
    deps: {
      playback: {
        create: async () => ({
          sessionId: "s",
          videoId: "v",
          generation: 1,
          ready: true,
          retryAfterMs: null,
        }),
        position: async (sessionId, request) => window(sessionId, request.generation),
        prefetch: async (sessionId, request) => window(sessionId, request.generation),
        segments: async (sessionId, request) => window(sessionId, request.generation),
      },
      media: { attach: async () => undefined, bufferedRanges },
      scheduler: { reset: () => undefined, appendInit: async () => undefined, fill },
      policy: {
        bufferGoalMs: 30_000,
        backBufferMs: 30_000,
        pollIntervalMs: 500,
        manifestRefreshMs: 8_000,
        manifestPollLimit: 2,
        segmentPollLimit: 2,
      },
    },
    config: {
      endpoint: "https://beta.typetype.video/api",
      videoId: "v",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: null,
    },
    video: { currentTime: 0 },
    response: { sessionId: "s", videoId: "v", generation: 1, ready: true, retryAfterMs: null },
    current: null,
    quality: undefined,
    startTimeMs: 0,
    signal: new AbortController().signal,
    recovery: new PlaybackRecovery(skipRecoveryDelay),
  });
}

test("hands the session over once a second plays, while a slow first segment still arrives", async () => {
  let release: (() => void) | null = null;
  const slowFill = new Promise<"filled">((resolve) => (release = () => resolve("filled")));
  let buffered: MediaBufferedRange[] = [];
  setTimeout(() => {
    buffered = [
      { kind: "audio", startMs: 0, endMs: 1_200 },
      { kind: "video", startMs: 0, endMs: 1_100 },
    ];
  }, 30);
  const started = Date.now();
  const session = await load(
    () => slowFill,
    () => buffered,
  );
  expect(session.response.sessionId).toBe("s");
  expect(Date.now() - started).toBeLessThan(1_000);
  release?.();
});

test("waits for the fill while one track has less than a second", async () => {
  let done = false;
  const fill = new Promise<"filled">((resolve) =>
    setTimeout(() => {
      done = true;
      resolve("filled");
    }, 120),
  );
  await load(
    () => fill,
    () => [
      { kind: "audio", startMs: 0, endMs: 5_000 },
      { kind: "video", startMs: 0, endMs: 400 },
    ],
  );
  expect(done).toBe(true);
});

test("a failing fill still fails the load before anything plays", async () => {
  await expect(
    load(
      async () => Promise.reject(new Error("segment gone")),
      () => [],
    ),
  ).rejects.toThrow("segment gone");
});

test("a second fill joins a segment still being appended instead of appending it again", async () => {
  const requests: string[] = [];
  const appended: number[] = [];
  let release: (() => void) | null = null;
  const firstSegment = new Promise<void>((resolve) => (release = resolve));
  const http = {
    once: async (url: string) => {
      requests.push(url);
      if (url === "/1") await firstSegment;
      return {
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        body: new Uint8Array([Number(url.slice(1))]).buffer,
      } satisfies HttpExchange;
    },
  } as unknown as HttpClient;
  const media = {
    append: async (_kind: "audio" | "video", bytes: ArrayBuffer) => {
      appended.push(new Uint8Array(bytes)[0] ?? -1);
    },
    bufferedRanges: () => [],
    resetParser: async () => undefined,
  } as unknown as MediaSourceController;
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);
  const audioOnly: PlaybackManifest = {
    ...manifest,
    video: null,
    audio: {
      ...manifest.audio,
      segments: [
        { url: "/1", startMs: 0, durationMs: 5_000 },
        { url: "/2", startMs: 5_000, durationMs: 5_000 },
      ],
    },
  };
  const startup = scheduler.fill(audioOnly, 0, 10_000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const loop = scheduler.fill(audioOnly, 0, 10_000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  release?.();
  await Promise.all([startup, loop]);
  expect(requests).toEqual(["/1", "/2"]);
  expect(appended).toEqual([1, 2]);
});
