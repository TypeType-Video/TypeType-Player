import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import type { PlaybackWindow, PlaybackWindowRequest } from "../src/playback-window";
import { loadPlaybackSession } from "../src/session-loader";

if (typeof globalThis.MediaSource === "undefined") {
  Object.defineProperty(globalThis, "MediaSource", {
    value: { isTypeSupported: () => true },
    configurable: true,
  });
}

const manifest: PlaybackManifest = {
  durationMs: 120_000,
  endOfStream: false,
  audio: {
    kind: "audio",
    mime: 'audio/mp4; codecs="mp4a.40.2"',
    initUrl: "/audio/init",
    segments: [],
  },
  video: {
    kind: "video",
    mime: 'video/webm; codecs="vp9"',
    initUrl: "/video/init",
    segments: [],
  },
};

function window(request: PlaybackWindowRequest, ready: boolean): PlaybackWindow {
  return {
    sessionId: "vp9-session",
    generation: request.generation,
    ready,
    retryAfterMs: null,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    manifest: ready ? manifest : null,
  };
}

test("starts a replacement media source without stale buffered ranges", async () => {
  const requests: PlaybackWindowRequest[] = [];
  const playback = {
    position: async (_sessionId: string, request: PlaybackWindowRequest) => {
      requests.push(request);
      return window(request, false);
    },
    prefetch: async (_sessionId: string, request: PlaybackWindowRequest) => window(request, true),
    segments: async (_sessionId: string, request: PlaybackWindowRequest) => window(request, true),
  };
  await loadPlaybackSession({
    playback,
    media: {
      attach: async () => undefined,
      bufferedRanges: () => [
        { kind: "audio", startMs: 0, endMs: 30_000 },
        { kind: "video", startMs: 0, endMs: 30_000 },
      ],
    },
    scheduler: { reset: () => undefined, appendInit: async () => undefined },
    video: { currentTime: 20 },
    response: {
      sessionId: "vp9-session",
      videoId: "dQw4w9WgXcQ",
      generation: 0,
      ready: false,
      retryAfterMs: null,
    },
    videoItag: 247,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
    startTimeMs: 20_000,
    policy: {
      bufferGoalMs: 30_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 2,
      segmentPollLimit: 2,
    },
    signal: new AbortController().signal,
  });
  expect(requests[0]?.videoItag).toBe(247);
  expect(requests[0]?.bufferedRanges).toEqual([]);
});

test("follows active playback while preparing a quality replacement", async () => {
  const requests: PlaybackWindowRequest[] = [];
  let currentTime = 20;
  const playback = {
    position: async (_sessionId: string, request: PlaybackWindowRequest) => {
      requests.push(request);
      currentTime = 21;
      return window(request, false);
    },
    prefetch: async (_sessionId: string, request: PlaybackWindowRequest) => {
      requests.push(request);
      currentTime = 22;
      return window(request, true);
    },
    segments: async (_sessionId: string, request: PlaybackWindowRequest) => {
      requests.push(request);
      return { ...window(request, true), startTimeMs: request.playerTimeMs };
    },
  };
  const session = await loadPlaybackSession({
    playback,
    media: { attach: async () => undefined, bufferedRanges: () => [] },
    scheduler: { reset: () => undefined, appendInit: async () => undefined },
    video: { currentTime },
    response: {
      sessionId: "vp9-session",
      videoId: "dQw4w9WgXcQ",
      generation: 0,
      startTimeMs: 20_000,
      ready: false,
      retryAfterMs: null,
    },
    videoItag: 247,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
    startTimeMs: 20_000,
    playerTimeMs: () => currentTime * 1000,
    policy: {
      bufferGoalMs: 30_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 2,
      segmentPollLimit: 2,
    },
    signal: new AbortController().signal,
  });

  expect(requests.map((request) => request.playerTimeMs)).toEqual([20_000, 21_000, 22_000]);
  expect(session.response.startTimeMs).toBe(22_000);
});
