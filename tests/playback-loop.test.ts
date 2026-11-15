import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import { PlaybackLoop } from "../src/playback-loop";
import type { PlaybackWindow, PlaybackWindowRequest } from "../src/playback-window";
import { type LoadedSession, PlaybackWindowRecoveryError } from "../src/session-loader";

const manifest: PlaybackManifest = {
  durationMs: 120_000,
  endOfStream: false,
  audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
  video: { kind: "video", mime: "video/mp4", initUrl: "/video/init", segments: [] },
};

function window(request: PlaybackWindowRequest): PlaybackWindow {
  return {
    sessionId: "session",
    generation: request.generation,
    ready: true,
    retryAfterMs: null,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    status: "ready",
    blockedBy: null,
    bufferedEdgeMs: 30_000,
    manifest,
  };
}

test("refreshes rapidly only while the playback buffer is below its low watermark", async () => {
  let bufferedEndMs = 5_000;
  let positionCalls = 0;
  let fillCalls = 0;
  const session: LoadedSession = {
    response: {
      sessionId: "session",
      videoId: "video",
      generation: 0,
      ready: true,
      retryAfterMs: null,
    },
    manifest,
    videoItag: 299,
    audioItag: 140,
    audioTrackId: null,
  };
  const loop = new PlaybackLoop({
    video: { currentTime: 0, paused: false, readyState: 4 },
    playback: {
      position: async (_sessionId, request) => {
        positionCalls += 1;
        return window(request);
      },
      prefetch: async (_sessionId, request) => window(request),
      segments: async (_sessionId, request) => window(request),
    },
    media: { bufferedRanges: () => [], endOfStream: () => false, trim: async () => undefined },
    scheduler: {
      fill: async () => {
        fillCalls += 1;
      },
    },
    emitter: { emit: () => undefined },
    policy: {
      bufferGoalMs: 30_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 2,
      segmentPollLimit: 2,
    },
    session: () => session,
    signal: () => new AbortController().signal,
    bufferedEndMs: () => bufferedEndMs,
    error: (error) => {
      throw error;
    },
  });

  await loop.fillOnce();
  await Bun.sleep(0);
  expect(positionCalls).toBe(1);
  expect(fillCalls).toBe(2);

  bufferedEndMs = 20_000;
  await loop.fillOnce();
  await Bun.sleep(0);
  expect(positionCalls).toBe(1);
  expect(fillCalls).toBe(3);

  bufferedEndMs = 19_999;
  await loop.fillOnce();
  await Bun.sleep(0);
  expect(positionCalls).toBe(2);
  expect(fillCalls).toBe(5);
});

test("closes the media source after appending the final window", async () => {
  let ended = 0;
  const session: LoadedSession = {
    response: {
      sessionId: "session",
      videoId: "video",
      generation: 0,
      ready: true,
      retryAfterMs: null,
    },
    manifest: { ...manifest, endOfStream: true },
    videoItag: 299,
    audioItag: 140,
    audioTrackId: null,
  };
  const loop = new PlaybackLoop({
    video: { currentTime: 119, paused: false, readyState: 4 },
    playback: {
      position: async (_sessionId, request) => window(request),
      prefetch: async (_sessionId, request) => window(request),
      segments: async (_sessionId, request) => window(request),
    },
    media: {
      bufferedRanges: () => [],
      endOfStream: () => {
        ended += 1;
        return true;
      },
      trim: async () => undefined,
    },
    scheduler: { fill: async () => undefined },
    emitter: { emit: () => undefined },
    policy: {
      bufferGoalMs: 30_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 2,
      segmentPollLimit: 2,
    },
    session: () => session,
    signal: () => new AbortController().signal,
    bufferedEndMs: () => 120_000,
    error: (error) => {
      throw error;
    },
  });

  await loop.fillOnce();

  expect(ended).toBe(1);
});

test("reports a terminal refresh with its exact session and operation signal", async () => {
  const signal = new AbortController().signal;
  const session: LoadedSession = {
    response: {
      sessionId: "active-session",
      videoId: "video",
      generation: 7,
      ready: true,
      retryAfterMs: null,
    },
    manifest,
    videoItag: 137,
    audioItag: 140,
    audioTrackId: "en-US.4",
    audioOnly: false,
  };
  let failure: Error | null = null;
  let failedSessionId: string | null = null;
  let failedSignal: AbortSignal | null = null;
  const loop = new PlaybackLoop({
    video: { currentTime: 379.441, paused: false, readyState: 4 },
    playback: {
      position: async (_sessionId, request) => window(request),
      prefetch: async (_sessionId, request) => ({
        ...window(request),
        ready: false,
        terminalError: "SABR demand stalled for 140:39",
        recoveryAction: "retry_fresh_session",
      }),
      segments: async (_sessionId, request) => window(request),
    },
    media: { bufferedRanges: () => [], endOfStream: () => false, trim: async () => undefined },
    scheduler: { fill: async () => undefined },
    emitter: { emit: () => undefined },
    policy: {
      bufferGoalMs: 30_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 2,
      segmentPollLimit: 2,
    },
    session: () => session,
    signal: () => signal,
    bufferedEndMs: () => 379_441,
    error: (error, context) => {
      failure = error;
      failedSessionId = context.sessionId;
      failedSignal = context.signal;
    },
  });

  await loop.fillOnce();
  await Bun.sleep(0);

  expect(failure).toBeInstanceOf(PlaybackWindowRecoveryError);
  expect(failedSessionId).toBe("active-session");
  expect(failedSignal).toBe(signal);
});

test("waits for an active fill before becoming quiescent", async () => {
  let releaseFill: (() => void) | null = null;
  const pendingFill = new Promise<void>((resolve) => {
    releaseFill = resolve;
  });
  const controller = new AbortController();
  const session: LoadedSession = {
    response: {
      sessionId: "old-session",
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
  const loop = new PlaybackLoop({
    video: { currentTime: 0, paused: false, readyState: 4 },
    playback: {
      position: async (_sessionId, request) => window(request),
      prefetch: async (_sessionId, request) => window(request),
      segments: async (_sessionId, request) => window(request),
    },
    media: { bufferedRanges: () => [], endOfStream: () => false, trim: async () => undefined },
    scheduler: { fill: async () => pendingFill },
    emitter: { emit: () => undefined },
    policy: {
      bufferGoalMs: 30_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 2,
      segmentPollLimit: 2,
    },
    session: () => session,
    signal: () => controller.signal,
    bufferedEndMs: () => 30_000,
    error: () => undefined,
  });
  const fill = loop.fillOnce().catch(() => undefined);
  await Bun.sleep(0);
  let quiescent = false;
  const quiesce = loop.quiesce().then(() => {
    quiescent = true;
  });
  await Bun.sleep(0);
  expect(quiescent).toBe(false);
  controller.abort();
  if (!releaseFill) throw new Error("Deferred fill was not initialized");
  releaseFill();
  await Promise.all([fill, quiesce]);

  expect(quiescent).toBe(true);
});

test("waits for an active manifest refresh before becoming quiescent", async () => {
  let releasePosition: ((value: PlaybackWindow) => void) | null = null;
  const pendingPosition = new Promise<PlaybackWindow>((resolve) => {
    releasePosition = resolve;
  });
  const controller = new AbortController();
  const session: LoadedSession = {
    response: {
      sessionId: "old-session",
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
  const loop = new PlaybackLoop({
    video: { currentTime: 0, paused: false, readyState: 4 },
    playback: {
      position: async () => pendingPosition,
      prefetch: async (_sessionId, request) => window(request),
      segments: async (_sessionId, request) => window(request),
    },
    media: { bufferedRanges: () => [], endOfStream: () => false, trim: async () => undefined },
    scheduler: { fill: async () => undefined },
    emitter: { emit: () => undefined },
    policy: {
      bufferGoalMs: 30_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 2,
      segmentPollLimit: 2,
    },
    session: () => session,
    signal: () => controller.signal,
    bufferedEndMs: () => 0,
    error: () => undefined,
  });
  const fill = loop.fillOnce();
  await Bun.sleep(0);
  let quiescent = false;
  const quiesce = loop.quiesce().then(() => {
    quiescent = true;
  });

  await Bun.sleep(0);
  expect(quiescent).toBe(false);
  if (!releasePosition) throw new Error("Deferred position was not initialized");
  releasePosition(
    window({
      generation: 0,
      playerTimeMs: 0,
      videoItag: 137,
      audioItag: 140,
      audioTrackId: null,
      audioOnly: false,
      bufferGoalMs: 30_000,
      backBufferMs: 30_000,
      bufferedRanges: [],
    }),
  );
  await Promise.all([fill, quiesce]);

  expect(quiescent).toBe(true);
});

test("does not attach a stale fill rejection to a restarted loop", async () => {
  let rejectFirstFill: ((error: Error) => void) | null = null;
  const firstFill = new Promise<void>((_resolve, reject) => {
    rejectFirstFill = reject;
  });
  let fillCalls = 0;
  const oldController = new AbortController();
  let currentController = oldController;
  const failures: Error[] = [];
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
  const loop = new PlaybackLoop({
    video: { currentTime: 0, paused: false, readyState: 4 },
    playback: {
      position: async (_sessionId, request) => window(request),
      prefetch: async (_sessionId, request) => window(request),
      segments: async (_sessionId, request) => window(request),
    },
    media: { bufferedRanges: () => [], endOfStream: () => false, trim: async () => undefined },
    scheduler: {
      fill: async () => {
        fillCalls += 1;
        if (fillCalls === 1) await firstFill;
      },
    },
    emitter: { emit: () => undefined },
    policy: {
      bufferGoalMs: 30_000,
      backBufferMs: 30_000,
      pollIntervalMs: 1,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 2,
      segmentPollLimit: 2,
    },
    session: () => session,
    signal: () => currentController.signal,
    bufferedEndMs: () => 30_000,
    error: (error) => failures.push(error),
  });
  const stale = loop.fillOnce().catch(() => undefined);
  oldController.abort();
  currentController = new AbortController();
  loop.start();
  await Bun.sleep(5);
  if (!rejectFirstFill) throw new Error("Deferred fill was not initialized");
  rejectFirstFill(new DOMException("Operation aborted", "AbortError"));
  await stale;
  await Bun.sleep(5);
  loop.stop();

  expect(failures).toHaveLength(0);
  expect(fillCalls).toBeGreaterThan(1);
});

test("uses shrunk quotaGoalLimitMs for manifest refresh threshold checks", async () => {
  let refreshes = 0;
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
  const loop = new PlaybackLoop({
    video: { currentTime: 0, paused: false, readyState: 4 },
    playback: {
      window: async (_sessionId, request) => {
        refreshes += 1;
        return window(request);
      },
      position: async (_sessionId, request) => window(request),
      prefetch: async (_sessionId, request) => window(request),
      segments: async (_sessionId, request) => window(request),
    },
    media: { bufferedRanges: () => [], endOfStream: () => false, trim: async () => undefined },
    scheduler: { fill: async () => "deferred" },
    emitter: { emit: () => undefined },
    policy: {
      bufferGoalMs: 10_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 25,
      manifestPollLimit: 2,
      segmentPollLimit: 2,
    },
    session: () => session,
    signal: () => new AbortController().signal,
    bufferedEndMs: () => 5_000,
    error: (error) => {
      throw error;
    },
  });

  await loop.fillOnce();
  loop.start();
  await Bun.sleep(40);
  loop.stop();
  expect(refreshes).toBe(0);
});

test("triggers manifest refresh earlier within the 10s goal after observing high control RTT", async () => {
  let bufferedEndMs = 6_000;
  let refreshes = 0;
  const requestedGoals: number[] = [];
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
  const loop = new PlaybackLoop({
    video: { currentTime: 0, paused: false, readyState: 4 },
    playback: {
      window: async (_sessionId, request) => {
        refreshes += 1;
        requestedGoals.push(request.bufferGoalMs);
        await Bun.sleep(420);
        return window(request);
      },
      position: async (_sessionId, request) => window(request),
      prefetch: async (_sessionId, request) => window(request),
      segments: async (_sessionId, request) => window(request),
    },
    media: { bufferedRanges: () => [], endOfStream: () => false, trim: async () => undefined },
    scheduler: { fill: async () => "filled" },
    emitter: { emit: () => undefined },
    policy: {
      bufferGoalMs: 10_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 2,
      segmentPollLimit: 2,
    },
    session: () => session,
    signal: () => new AbortController().signal,
    bufferedEndMs: () => bufferedEndMs,
    error: (error) => {
      throw error;
    },
  });

  await loop.fillOnce();
  expect(refreshes).toBe(1);
  expect(requestedGoals).toEqual([10_000]);

  bufferedEndMs = 7_000;
  await loop.fillOnce();
  expect(refreshes).toBe(2);
  expect(requestedGoals).toEqual([10_000, 10_000]);
});
