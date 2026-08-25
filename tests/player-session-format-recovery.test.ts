import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import type { PlaybackResponse } from "../src/playback-client";
import type { PlaybackWindow, PlaybackWindowRequest } from "../src/playback-window";
import { PlaybackRecovery } from "../src/player-recovery";
import { loadPlayerSession } from "../src/player-session-loader";

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
    segments: [{ url: "/audio/6", startMs: 50_000, durationMs: 20_000 }],
  },
  video: {
    kind: "video",
    mime: 'video/mp4; codecs="avc1.640028"',
    initUrl: "/video/init",
    segments: [{ url: "/video/12", startMs: 59_000, durationMs: 11_000 }],
  },
};

function response(sessionId: string, videoId = "V_YKnVyUJgQ"): PlaybackResponse {
  return { sessionId, videoId, generation: 1, ready: false, retryAfterMs: null };
}

function window(sessionId: string, request: PlaybackWindowRequest, ready: boolean): PlaybackWindow {
  return {
    sessionId,
    generation: ready ? 2 : request.generation,
    ready,
    retryAfterMs: null,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    manifest: ready ? manifest : null,
  };
}

test("recovers a 4x seek window without changing the selected video itag", async () => {
  const createVideoItags: number[] = [];
  const requests: PlaybackWindowRequest[] = [];
  const filledWindows: Array<[number, number, number]> = [];
  const video = { currentTime: 0 };
  const session = await loadPlayerSession({
    deps: {
      playback: {
        create: async (request) => {
          createVideoItags.push(request.videoItag);
          return response(`fresh-${request.videoItag}`, request.videoId);
        },
        position: async (sessionId, request) => {
          requests.push(request);
          return window(sessionId, request, false);
        },
        prefetch: async (sessionId, request) => {
          requests.push(request);
          if (sessionId !== "seek-session") return window(sessionId, request, true);
          return {
            ...window(sessionId, request, false),
            terminalError: "video:137:12 status=3 protected no-media",
            recoveryAction: "retry_fresh_session_lower_video_itag",
            retryVideoItags: [248, 136, 135],
          };
        },
        segments: async (sessionId, request) => {
          requests.push(request);
          return window(sessionId, request, true);
        },
      },
      media: {
        attach: async () => undefined,
        bufferedRanges: () => [{ kind: "video", startMs: 0, endMs: 10_000 }],
      },
      scheduler: {
        reset: () => undefined,
        appendInit: async () => undefined,
        fill: async (nextManifest, startMs, endMs) => {
          filledWindows.push([nextManifest.durationMs, startMs, endMs]);
        },
      },
      policy: {
        bufferGoalMs: 30_000,
        backBufferMs: 30_000,
        pollIntervalMs: 500,
        manifestRefreshMs: 8_000,
        manifestPollLimit: 2,
        segmentPollLimit: 2,
      },
      playbackRate: () => 4,
    },
    config: {
      endpoint: "https://beta.typetype.video/api",
      videoId: "V_YKnVyUJgQ",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: null,
    },
    video,
    response: response("seek-session"),
    current: null,
    quality: undefined,
    startTimeMs: 60_000,
    signal: new AbortController().signal,
    recovery: new PlaybackRecovery(),
  });

  expect(session.response.sessionId).toBe("fresh-137");
  expect(session.videoItag).toBe(137);
  expect(createVideoItags).toEqual([137]);
  expect(requests.map((request) => request.playbackRate)).toEqual([4, 4, 4, 4, 4]);
  expect(requests.map((request) => request.bufferGoalMs)).toEqual([
    10_000, 10_000, 10_000, 10_000, 10_000,
  ]);
  expect(filledWindows).toEqual([[120_000, 59_000, 70_000]]);
});
