import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import type { PlaybackWindow, PlaybackWindowRequest } from "../src/playback-window";
import { type LoadedSession, refreshPlaybackWindow } from "../src/session-loader";

const manifest: PlaybackManifest = {
  durationMs: 120_000,
  endOfStream: false,
  audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
  video: { kind: "video", mime: "video/mp4", initUrl: "/video/init", segments: [] },
};

test("refreshes playback state while polling a delayed window", async () => {
  let playerTimeMs = 37_000;
  let bufferedEndMs = 52_000;
  let prefetchCount = 0;
  const requests: PlaybackWindowRequest[] = [];
  const response = (request: PlaybackWindowRequest, ready: boolean): PlaybackWindow => ({
    sessionId: "session",
    generation: request.generation,
    ready,
    retryAfterMs: 1,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    status: ready ? "ready" : "idle",
    blockedBy: ready ? null : "video:137:15 pending",
    bufferedEdgeMs: bufferedEndMs,
    manifest: ready ? manifest : null,
  });
  const playback = {
    position: async (_sessionId: string, request: PlaybackWindowRequest) => {
      requests.push(request);
      return response(request, false);
    },
    prefetch: async (_sessionId: string, request: PlaybackWindowRequest) => {
      requests.push(request);
      prefetchCount += 1;
      if (prefetchCount === 1) {
        playerTimeMs = 66_000;
        bufferedEndMs = 69_000;
        return response(request, false);
      }
      return response(request, true);
    },
    segments: async (_sessionId: string, request: PlaybackWindowRequest) => {
      requests.push(request);
      return response(request, true);
    },
  };
  const session: LoadedSession = {
    response: {
      sessionId: "session",
      videoId: "video",
      generation: 0,
      ready: true,
      retryAfterMs: null,
    },
    manifest,
    videoItag: 137,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
  };
  const media = {
    bufferedRanges: () => [
      { kind: "video" as const, startMs: 14_000, endMs: bufferedEndMs },
      { kind: "audio" as const, startMs: 13_500, endMs: bufferedEndMs },
    ],
  };

  await refreshPlaybackWindow(
    playback,
    media,
    session,
    {
      bufferGoalMs: 30_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 3,
      segmentPollLimit: 3,
    },
    () => playerTimeMs,
    new AbortController().signal,
    () => 4,
  );

  expect(requests.map((request) => request.playerTimeMs)).toEqual([37_000, 37_000, 66_000, 66_000]);
  expect(requests.map((request) => request.playbackRate)).toEqual([4, 4, 4, 4]);
  expect(requests.map((request) => request.bufferGoalMs)).toEqual([60_000, 60_000, 60_000, 60_000]);
  expect(requests.at(-1)?.bufferedRanges.map((range) => range.endMs)).toEqual([69_000, 69_000]);
});
