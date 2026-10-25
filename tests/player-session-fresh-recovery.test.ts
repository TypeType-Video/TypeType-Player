import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import type { PlaybackResponse } from "../src/playback-client";
import type { PlaybackWindow, PlaybackWindowRequest } from "../src/playback-window";
import { PlaybackRecovery } from "../src/player-recovery";
import { loadPlayerSession } from "../src/player-session-loader";
import { skipRecoveryDelay } from "./fake-retry-timing";

Object.defineProperty(globalThis, "MediaSource", {
  value: { isTypeSupported: (mime: string) => mime.length > 0 },
  configurable: true,
});

const manifest: PlaybackManifest = {
  durationMs: 600_000,
  endOfStream: false,
  audio: {
    kind: "audio",
    mime: 'audio/mp4; codecs="mp4a.40.2"',
    initUrl: "/140/init",
    segments: [{ url: "/140/39", startMs: 369_000, durationMs: 10_000 }],
  },
  video: {
    kind: "video",
    mime: 'video/mp4; codecs="avc1.640028"',
    initUrl: "/137/init",
    segments: [{ url: "/137/69", startMs: 369_000, durationMs: 6_000 }],
  },
};

function response(sessionId: string): PlaybackResponse {
  return {
    sessionId,
    videoId: "nt1TGErpc0Q",
    generation: 0,
    ready: false,
    retryAfterMs: null,
  };
}

function window(sessionId: string, generation: number | null, terminal = false): PlaybackWindow {
  return {
    sessionId,
    generation,
    ready: !terminal,
    retryAfterMs: null,
    terminalError: terminal ? "SABR demand stalled for 140:39" : null,
    recoveryAction: terminal ? "retry_fresh_session" : null,
    retryVideoItags: [],
    manifest: terminal ? null : manifest,
  };
}

test("initial loading uses two fresh sessions before succeeding", async () => {
  const creates: Array<{ videoItag: number; audioTrackId: string | null; startTimeMs: number }> =
    [];
  const prefetchSessions: string[] = [];
  const recovery = new PlaybackRecovery(skipRecoveryDelay);
  const session = await loadPlayerSession({
    deps: {
      playback: {
        create: async (request) => {
          creates.push({
            videoItag: request.videoItag,
            audioTrackId: request.audioTrackId ?? null,
            startTimeMs: request.startTimeMs ?? 0,
          });
          return response(`fresh-${creates.length}`);
        },
        position: async (sessionId, request) => pendingWindow(sessionId, request),
        prefetch: async (sessionId, request) => {
          prefetchSessions.push(sessionId);
          return window(sessionId, request.generation, sessionId !== "fresh-2");
        },
        segments: async (sessionId, request) => window(sessionId, request.generation),
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
      endpoint: "https://beta.typetype.video/api",
      videoId: "nt1TGErpc0Q",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: "en-US.4",
    },
    video: { currentTime: 379.441 },
    response: response("source"),
    current: null,
    quality: undefined,
    startTimeMs: 379_441,
    signal: new AbortController().signal,
    recovery,
  });

  expect(prefetchSessions).toEqual(["source", "fresh-1", "fresh-2"]);
  expect(creates).toEqual([
    { videoItag: 137, audioTrackId: "en-US.4", startTimeMs: 379_441 },
    { videoItag: 137, audioTrackId: "en-US.4", startTimeMs: 379_441 },
  ]);
  expect(session.response.sessionId).toBe("fresh-2");
  expect(recovery.begin("fresh-2")).toBe("exhausted");
});

function pendingWindow(sessionId: string, request: PlaybackWindowRequest): PlaybackWindow {
  return {
    ...window(sessionId, request.generation, true),
    terminalError: null,
    recoveryAction: null,
  };
}
