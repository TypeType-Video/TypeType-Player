import { expect, test } from "bun:test";
import { type HttpClient, TypeTypeHttpError } from "../src/http-client";
import type { PlaybackManifest } from "../src/manifest";
import { PlaybackClient } from "../src/playback-client";
import type { PlaybackWindow, PlaybackWindowRequest } from "../src/playback-window";
import { PlaybackWindowRecoveryError } from "../src/playback-window-error";
import { RequestStallError } from "../src/request-watchdog";
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

test("adopts the active generation returned by a stale position update", async () => {
  const requestGenerations: number[] = [];
  const response = (generation: number, ready: boolean): PlaybackWindow => ({
    sessionId: "session",
    generation,
    ready,
    retryAfterMs: 1,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    status: ready ? "ready" : "idle",
    blockedBy: ready ? null : "video:137:15 pending",
    bufferedEdgeMs: 69_000,
    manifest: ready ? manifest : null,
  });
  const playback = {
    position: async (_sessionId: string, _request: PlaybackWindowRequest) => response(7, false),
    prefetch: async (_sessionId: string, request: PlaybackWindowRequest) => {
      requestGenerations.push(request.generation ?? -1);
      return response(7, true);
    },
    segments: async (_sessionId: string, request: PlaybackWindowRequest) => {
      requestGenerations.push(request.generation ?? -1);
      return response(7, true);
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

  await refreshPlaybackWindow(
    playback,
    {
      bufferedRanges: () => [],
    },
    session,
    {
      bufferGoalMs: 30_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 3,
      segmentPollLimit: 3,
    },
    () => 37_000,
    new AbortController().signal,
  );

  expect(requestGenerations).toEqual([7, 7]);
  expect(session.response.generation).toBe(7);
});

test("uses single-RTT window endpoint when provided and falls back on 400 or 404", async () => {
  const calls: string[] = [];
  const rtts: number[] = [];
  const session: LoadedSession = {
    response: {
      sessionId: "session",
      videoId: "video",
      generation: 1,
      ready: true,
      retryAfterMs: null,
    },
    manifest,
    videoItag: 137,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
  };
  const policy = {
    bufferGoalMs: 10_000,
    backBufferMs: 30_000,
    pollIntervalMs: 500,
    manifestRefreshMs: 8_000,
    manifestPollLimit: 2,
    segmentPollLimit: 2,
  };
  const readyWindow = (request: PlaybackWindowRequest, generation: number): PlaybackWindow => ({
    sessionId: "session",
    generation,
    ready: true,
    retryAfterMs: null,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    status: "ready",
    blockedBy: null,
    bufferedEdgeMs: 20_000,
    manifest: { ...manifest, startTimeMs: request.playerTimeMs },
  });

  await refreshPlaybackWindow(
    {
      window: async (_id, request) => {
        calls.push("window");
        return readyWindow(request, 2);
      },
      position: async (_id, request) => {
        calls.push("position");
        return readyWindow(request, 2);
      },
      prefetch: async (_id, request) => {
        calls.push("prefetch");
        return readyWindow(request, 2);
      },
      segments: async (_id, request) => {
        calls.push("segments");
        return readyWindow(request, 2);
      },
    },
    { bufferedRanges: () => [] },
    session,
    policy,
    () => 5_000,
    new AbortController().signal,
    undefined,
    undefined,
    (rttMs) => rtts.push(rttMs),
  );

  expect(calls).toEqual(["window"]);
  expect(session.response.generation).toBe(2);
  expect(rtts).toHaveLength(1);

  calls.length = 0;
  await refreshPlaybackWindow(
    {
      window: async () => {
        calls.push("window-400");
        throw new TypeTypeHttpError("Invalid generation", 400);
      },
      position: async (_id, request) => {
        calls.push("position");
        return readyWindow(request, 3);
      },
      prefetch: async (_id, request) => {
        calls.push("prefetch");
        return readyWindow(request, 3);
      },
      segments: async (_id, request) => {
        calls.push("segments");
        return readyWindow(request, 3);
      },
    },
    { bufferedRanges: () => [] },
    session,
    policy,
    () => 8_000,
    new AbortController().signal,
  );

  expect(calls).toEqual(["window-400", "position", "prefetch", "segments"]);
  expect(session.response.generation).toBe(3);
});

test("preserves the playback receiver when invoking class-based window method", async () => {
  class ReceiverPlayback {
    private readonly suffix = ":bound";

    async window(_sessionId: string, request: PlaybackWindowRequest): Promise<PlaybackWindow> {
      return {
        sessionId: `session${this.suffix}`,
        generation: (request.generation ?? 0) + 1,
        ready: true,
        retryAfterMs: null,
        terminalError: null,
        recoveryAction: null,
        retryVideoItags: [],
        status: "ready",
        blockedBy: null,
        bufferedEdgeMs: 25_000,
        manifest: { ...manifest, startTimeMs: request.playerTimeMs },
      };
    }

    async position(): Promise<PlaybackWindow> {
      throw new Error("position should not be called");
    }

    async prefetch(): Promise<PlaybackWindow> {
      throw new Error("prefetch should not be called");
    }

    async segments(): Promise<PlaybackWindow> {
      throw new Error("segments should not be called");
    }
  }

  const session: LoadedSession = {
    response: {
      sessionId: "session:bound",
      videoId: "video",
      generation: 1,
      ready: true,
      retryAfterMs: null,
    },
    manifest,
    videoItag: 137,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
  };

  await refreshPlaybackWindow(
    new ReceiverPlayback(),
    { bufferedRanges: () => [] },
    session,
    {
      bufferGoalMs: 10_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 2,
      segmentPollLimit: 2,
    },
    () => 5_000,
    new AbortController().signal,
  );

  expect(session.response.generation).toBe(2);
});

test("falls back from PlaybackClient 404 on /window and preserves 410 or non-fallback errors", async () => {
  const mkWindow = (generation: number, startTimeMs: number) => ({
    sessionId: "session",
    generation,
    ready: true,
    retryAfterMs: null,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    status: "ready",
    blockedBy: null,
    bufferedEdgeMs: 25_000,
    manifest: { ...manifest, startTimeMs },
  });
  const policy = {
    bufferGoalMs: 10_000,
    backBufferMs: 30_000,
    pollIntervalMs: 500,
    manifestRefreshMs: 8_000,
    manifestPollLimit: 2,
    segmentPollLimit: 2,
  };
  const mkSession = (): LoadedSession => ({
    response: {
      sessionId: "session",
      videoId: "video",
      generation: 1,
      ready: true,
      retryAfterMs: null,
    },
    manifest,
    videoItag: 137,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
  });

  // Real PlaybackClient integration: HTTP 404 on /window falls back to granular endpoints
  const clientPaths: string[] = [];
  const playbackClient = new PlaybackClient({
    json: async (path: string) => {
      clientPaths.push(path);
      if (path.endsWith("/window")) throw new TypeTypeHttpError("Not Found", 404);
      return mkWindow(4, 6_000);
    },
    absolute: (path: string) => `https://example.test${path}`,
  } as unknown as HttpClient);
  const clientSession = mkSession();
  await refreshPlaybackWindow(
    playbackClient,
    { bufferedRanges: () => [] },
    clientSession,
    policy,
    () => 6_000,
    new AbortController().signal,
  );
  expect(clientPaths).toEqual([
    "/sabr/playback/session/window",
    "/sabr/playback/session/position",
    "/sabr/playback/session/prefetch",
    "/sabr/playback/session/segments",
  ]);
  expect(clientSession.response.generation).toBe(4);

  // HTTP 410 on /window still fails fast as session expiry
  const goneClient = new PlaybackClient({
    json: async () => {
      throw new TypeTypeHttpError("Gone", 410);
    },
    absolute: (path: string) => `https://example.test${path}`,
  } as unknown as HttpClient);
  await expect(
    refreshPlaybackWindow(
      goneClient,
      { bufferedRanges: () => [] },
      mkSession(),
      policy,
      () => 0,
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(PlaybackWindowRecoveryError);

  // Fallback status matrix (404, 405, 501) vs non-fallback errors (401, 500, AbortError, RequestStallError)
  for (const status of [404, 405, 501]) {
    const seen: string[] = [];
    const granular = (name: string) => async (_id: string, req: PlaybackWindowRequest) => {
      seen.push(name);
      return mkWindow(2, req.playerTimeMs);
    };
    await refreshPlaybackWindow(
      {
        window: async () => {
          seen.push("window");
          throw new TypeTypeHttpError(`HTTP ${status}`, status);
        },
        position: granular("position"),
        prefetch: granular("prefetch"),
        segments: granular("segments"),
      },
      { bufferedRanges: () => [] },
      mkSession(),
      policy,
      () => 0,
      new AbortController().signal,
    );
    expect(seen).toEqual(["window", "position", "prefetch", "segments"]);
  }

  for (const failure of [
    new TypeTypeHttpError("Unauthorized", 401),
    new TypeTypeHttpError("Internal Server Error", 500),
    new DOMException("Aborted", "AbortError"),
    new RequestStallError(),
  ]) {
    let granularCalls = 0;
    const failGranular = async (_id: string, req: PlaybackWindowRequest) => {
      granularCalls += 1;
      return mkWindow(2, req.playerTimeMs);
    };
    await expect(
      refreshPlaybackWindow(
        {
          window: async () => {
            throw failure;
          },
          position: failGranular,
          prefetch: failGranular,
          segments: failGranular,
        },
        { bufferedRanges: () => [] },
        mkSession(),
        policy,
        () => 0,
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
    expect(granularCalls).toBe(0);
  }
});
