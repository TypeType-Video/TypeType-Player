import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import type { PlaybackResponse } from "../src/playback-client";
import type { PlaybackWindow } from "../src/playback-window";
import { PlaybackRecovery } from "../src/player-recovery";
import { loadPlayerSessionOnce } from "../src/player-session-loader";
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
    segments: [{ url: "/audio/1", startMs: 0, durationMs: 10_000 }],
  },
  video: {
    kind: "video",
    mime: 'video/mp4; codecs="avc1.640028"',
    initUrl: "/video/init",
    segments: [{ url: "/video/1", startMs: 0, durationMs: 5_000 }],
  },
};

function window(sessionId: string, ready: boolean, withManifest: boolean): PlaybackWindow {
  return {
    sessionId,
    generation: 0,
    ready,
    retryAfterMs: null,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    manifest: withManifest ? manifest : null,
  };
}

async function load(response: PlaybackResponse, segmentsReady: boolean) {
  const calls: string[] = [];
  await loadPlayerSessionOnce({
    deps: {
      playback: {
        create: async () => response,
        position: async (id) => {
          calls.push("position");
          return window(id, false, false);
        },
        prefetch: async (id) => {
          calls.push("prefetch");
          return window(id, true, false);
        },
        segments: async (id) => {
          calls.push("segments");
          const ready = segmentsReady || calls.includes("prefetch");
          return window(id, ready, ready);
        },
      },
      media: { attach: async () => undefined, bufferedRanges: () => [] },
      scheduler: {
        reset: () => undefined,
        appendInit: async () => undefined,
        fill: async () => undefined,
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
      endpoint: "https://example.test/api",
      videoId: "v",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: null,
    },
    video: { currentTime: 0 },
    response,
    current: null,
    quality: undefined,
    startTimeMs: 0,
    signal: new AbortController().signal,
    recovery: new PlaybackRecovery(skipRecoveryDelay),
  });
  return calls;
}

const base: PlaybackResponse = {
  sessionId: "s",
  videoId: "v",
  generation: 0,
  ready: false,
  retryAfterMs: null,
};

test("a session the server answered ready asks for its window at once", async () => {
  expect(await load({ ...base, ready: true }, true)).toEqual(["segments"]);
});

test("a ready session whose window is not ready yet falls back to waiting for it", async () => {
  expect(await load({ ...base, ready: true }, false)).toEqual([
    "segments",
    "position",
    "prefetch",
    "segments",
  ]);
});

test("a session still preparing waits through position and prefetch", async () => {
  expect(await load(base, true)).toEqual(["position", "prefetch", "segments"]);
});
