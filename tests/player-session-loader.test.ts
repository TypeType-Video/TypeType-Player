import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import type { PlaybackResponse } from "../src/playback-client";
import type { PlaybackWindow } from "../src/playback-window";
import { PlaybackRecovery } from "../src/player-recovery";
import { loadPlayerSession, loadPlayerSessionOnce } from "../src/player-session-loader";

Object.defineProperty(globalThis, "MediaSource", {
  value: {
    isTypeSupported(mime: string): boolean {
      return mime.length > 0;
    },
  },
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

test("uses the server-resolved live start for the first window and buffer fill", async () => {
  const requestedPositions: number[] = [];
  const requestedSelections: Array<[number, number, string | null]> = [];
  const filledWindows: Array<[number, number]> = [];
  const live = {
    active: true,
    postLiveDvr: false,
    headSequence: 12,
    headTimeMs: 72_000,
    seekableStartMs: 0,
    seekableEndMs: 72_000,
    atLiveEdge: true,
    targetLatencyMs: 10_000,
  };
  const session = await loadPlayerSession({
    deps: {
      playback: {
        create: async () => response("unused"),
        position: async (sessionId, request) => {
          requestedPositions.push(request.playerTimeMs);
          requestedSelections.push([request.videoItag, request.audioItag, request.audioTrackId]);
          return { ...window(sessionId, request.generation, false), startTimeMs: 60_000, live };
        },
        prefetch: async (sessionId, request) => ({
          ...window(sessionId, request.generation, true),
          startTimeMs: 60_000,
          live,
          manifest: { ...manifest, startTimeMs: 60_000, live },
        }),
        segments: async (sessionId, request) => ({
          ...window(sessionId, request.generation, true),
          startTimeMs: 60_000,
          live,
          manifest: { ...manifest, startTimeMs: 60_000, live },
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
      videoId: "live-video",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: null,
      isLive: true,
    },
    video: { currentTime: 0 },
    response: {
      ...response("live-session", "live-video"),
      videoItag: 248,
      audioItag: 251,
      audioTrackId: "fr-FR.4",
      startTimeMs: 60_000,
      live,
    },
    current: null,
    quality: undefined,
    startTimeMs: 0,
    signal: new AbortController().signal,
    recovery: new PlaybackRecovery(),
  });

  expect(requestedPositions).toEqual([60_000]);
  expect(requestedSelections).toEqual([[248, 251, "fr-FR.4"]]);
  expect(filledWindows).toEqual([[59_000, 64_000]]);
  expect(session.response.startTimeMs).toBe(60_000);
  expect(session.manifest.live?.active).toBe(true);
});

test("keeps current media active until a replacement window is ready", async () => {
  let releasePrefetch: (() => void) | null = null;
  let quiesced = false;
  let attached = false;
  const prefetchReady = new Promise<void>((resolve) => (releasePrefetch = resolve));
  const task = loadPlayerSessionOnce({
    deps: {
      playback: {
        create: async () => response("unused"),
        position: async (sessionId, request) => window(sessionId, request.generation, false),
        prefetch: async (sessionId, request) => {
          await prefetchReady;
          return window(sessionId, request.generation, true);
        },
        segments: async (sessionId, request) => ({
          ...window(sessionId, request.generation, true),
          manifest,
        }),
      },
      media: {
        attach: async () => {
          expect(quiesced).toBe(true);
          attached = true;
        },
        bufferedRanges: () => [],
      },
      scheduler: {
        appendInit: async () => undefined,
        fill: async () => undefined,
        reset: () => undefined,
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
      videoId: "V_YKnVyUJgQ",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: null,
    },
    video: { currentTime: 0 },
    response: response("replacement"),
    current: null,
    quality: undefined,
    startTimeMs: 0,
    signal: new AbortController().signal,
    recovery: new PlaybackRecovery(),
    beforeAttach: async () => {
      quiesced = true;
    },
  });

  await Bun.sleep(0);
  expect(quiesced).toBe(false);
  expect(attached).toBe(false);
  if (!releasePrefetch) throw new Error("Deferred prefetch was not initialized");
  releasePrefetch();
  await task;

  expect(quiesced).toBe(true);
  expect(attached).toBe(true);
});

test("recovers invalid sabr context with a fresh session using the same formats", async () => {
  const created: number[] = [];
  const session = await loadPlayerSession({
    deps: {
      playback: {
        create: async (request) => {
          created.push(request.videoItag);
          return response("fresh-session", request.videoId);
        },
        position: async (sessionId, request) => window(sessionId, request.generation, false),
        prefetch: async (sessionId, request) =>
          sessionId === "stale-session"
            ? {
                ...window(sessionId, request.generation, false),
                terminalError: "Expected UMP response, got content type: text/plain",
                recoveryAction: "retry_fresh_session",
              }
            : { ...window(sessionId, request.generation, true), manifest },
        segments: async (sessionId, request) => ({
          ...window(sessionId, request.generation, true),
          manifest,
        }),
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
      videoId: "Vj6ReOur1Kk",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: "fr-FR.4",
    },
    video: { currentTime: 399.383 },
    response: response("stale-session", "Vj6ReOur1Kk"),
    current: null,
    quality: undefined,
    startTimeMs: 399_383,
    signal: new AbortController().signal,
    recovery: new PlaybackRecovery(),
  });

  expect(created).toEqual([137]);
  expect(session.response.sessionId).toBe("fresh-session");
  expect(session.videoItag).toBe(137);
});

function window(sessionId: string, generation: number | null, ready: boolean): PlaybackWindow {
  return {
    sessionId,
    generation,
    ready,
    retryAfterMs: null,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    manifest: null,
  };
}
