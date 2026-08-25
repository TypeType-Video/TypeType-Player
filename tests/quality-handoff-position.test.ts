import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import type { PlaybackResponse } from "../src/playback-client";
import type { PlaybackWindow, PlaybackWindowRequest } from "../src/playback-window";
import { PlaybackRecovery } from "../src/player-recovery";
import { loadPlayerSessionOnce } from "../src/player-session-loader";

Object.defineProperty(globalThis, "MediaSource", {
  value: { isTypeSupported: () => true },
  configurable: true,
});

const manifest: PlaybackManifest = {
  durationMs: 120_000,
  endOfStream: false,
  audio: {
    kind: "audio",
    mime: 'audio/mp4; codecs="mp4a.40.2"',
    initUrl: "/audio/init",
    segments: [{ url: "/audio/2", startMs: 20_000, durationMs: 10_000 }],
  },
  video: {
    kind: "video",
    mime: 'video/mp4; codecs="avc1.640028"',
    initUrl: "/video/init",
    segments: [{ url: "/video/4", startMs: 19_000, durationMs: 6_000 }],
  },
};

test("uses the exact playing handoff position for a quality replacement", async () => {
  let currentTime = 20;
  const filledWindows: Array<[number, number]> = [];
  const session = await loadPlayerSessionOnce({
    deps: {
      playback: {
        create: async () => response(),
        position: async (sessionId, request) => window(sessionId, request, false),
        prefetch: async (sessionId, request) => window(sessionId, request, true),
        segments: async (sessionId, request) => ({
          ...window(sessionId, request, true),
          startTimeMs: 22_000,
          manifest,
        }),
      },
      media: { attach: async () => undefined, bufferedRanges: () => [] },
      scheduler: {
        reset: () => undefined,
        appendInit: async () => undefined,
        fill: async (_manifest, startMs, endMs) => filledWindows.push([startMs, endMs]),
      },
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
      videoId: "quality-video",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: null,
    },
    video: {
      get currentTime() {
        return currentTime;
      },
      paused: false,
    },
    response: response(),
    current: null,
    quality: { videoItag: 137 },
    startTimeMs: 20_000,
    playerTimeMs: () => Math.round(currentTime * 1000),
    signal: new AbortController().signal,
    recovery: new PlaybackRecovery(),
    beforeAttach: async () => {
      currentTime = 22.375;
    },
  });

  expect(session.response.startTimeMs).toBe(22_375);
  expect(session.manifest.startTimeMs).toBe(22_375);
  expect(filledWindows).toEqual([[20_000, 24_875]]);
});

function response(): PlaybackResponse {
  return {
    sessionId: "replacement",
    videoId: "quality-video",
    generation: 0,
    startTimeMs: 20_000,
    ready: false,
    retryAfterMs: null,
  };
}

function window(sessionId: string, request: PlaybackWindowRequest, ready: boolean): PlaybackWindow {
  return {
    sessionId,
    generation: request.generation,
    ready,
    retryAfterMs: null,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    manifest: ready ? manifest : null,
  };
}
