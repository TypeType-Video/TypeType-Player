import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import { PlaybackLoop } from "../src/playback-loop";
import type { PlaybackWindow, PlaybackWindowRequest } from "../src/playback-window";
import { SegmentGenerationConflictError } from "../src/playback-window-error";
import type { LoadedSession } from "../src/session-loader";

function manifest(generation: number): PlaybackManifest {
  const url = `/segment?generation=${generation}`;
  return {
    durationMs: 120_000,
    endOfStream: false,
    audio: {
      kind: "audio",
      mime: "audio/mp4",
      initUrl: "/audio/init",
      segments: [{ url, startMs: 0, durationMs: 10_000 }],
    },
    video: null,
  };
}

function window(request: PlaybackWindowRequest, generation: number): PlaybackWindow {
  return {
    sessionId: "session",
    generation,
    ready: true,
    retryAfterMs: null,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    status: "ready",
    blockedBy: null,
    bufferedEdgeMs: request.playerTimeMs + 30_000,
    manifest: manifest(generation),
  };
}

function loop(conflicts: number) {
  const fills: string[] = [];
  const errors: Error[] = [];
  let generation = 0;
  const session: LoadedSession = {
    response: { sessionId: "session", videoId: "video", generation, ready: true, retryAfterMs: 0 },
    manifest: manifest(generation),
    videoItag: 299,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: true,
  };
  const playbackLoop = new PlaybackLoop({
    video: { currentTime: 0, paused: false, readyState: 4 },
    playback: {
      position: async (_sessionId, request) => window(request, generation),
      prefetch: async (_sessionId, request) => window(request, generation),
      segments: async (_sessionId, request) => {
        generation += 1;
        return window(request, generation);
      },
    },
    media: { bufferedRanges: () => [], endOfStream: () => false, trim: async () => undefined },
    scheduler: {
      fill: async (current) => {
        const url = current.audio.segments[0]?.url ?? "";
        fills.push(url);
        if (fills.length <= conflicts) throw new SegmentGenerationConflictError();
      },
    },
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
    bufferedEndMs: () => 30_000,
    error: (error) => errors.push(error),
  });
  return { playbackLoop, fills, errors };
}

test("refreshes the window and retries with new URLs after a stale generation", async () => {
  const { playbackLoop, fills } = loop(1);

  await playbackLoop.fillOnce();

  expect(fills).toEqual(["/segment?generation=0", "/segment?generation=1"]);
});

test("falls back to fresh session recovery when the generation stays stale", async () => {
  const { playbackLoop, fills } = loop(10);

  const error = await playbackLoop.fillOnce().catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(SegmentGenerationConflictError);
  expect(fills).toHaveLength(3);
});
