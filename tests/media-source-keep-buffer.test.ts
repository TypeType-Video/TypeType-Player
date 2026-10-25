import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import { MediaElementPlaybackError } from "../src/media-element-observer";
import { MediaSourceController } from "../src/media-source-controller";
import type { PlaybackWindow } from "../src/playback-window";
import { PlaybackRecovery } from "../src/player-recovery";
import { loadPlayerSessionOnce } from "../src/player-session-loader";
import { skipRecoveryDelay } from "./fake-retry-timing";
import { harness, recoveryError, response } from "./type-type-mse-recovery-harness";

Object.defineProperty(globalThis, "MediaSource", {
  value: { isTypeSupported: (mime: string) => mime.length > 0 },
  configurable: true,
});

const manifest: PlaybackManifest = {
  durationMs: 600_000,
  endOfStream: false,
  audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
  video: { kind: "video", mime: "video/mp4", initUrl: "/video/init", segments: [] },
};

function reusableController() {
  const calls: string[] = [];
  const video = { src: "blob:stable" } as HTMLVideoElement;
  const controller = new MediaSourceController(video);
  const queue = (kind: string) => ({
    reset: async () => {
      calls.push(`reset:${kind}`);
    },
    clear: () => calls.push(`clear:${kind}`),
  });
  Object.assign(controller, {
    objectUrl: "blob:stable",
    mediaSource: {
      readyState: "open",
      duration: 600,
      setLiveSeekableRange: () => undefined,
      clearLiveSeekableRange: () => undefined,
    },
    audioMime: "audio/mp4",
    videoMime: "video/mp4",
    audioQueue: queue("audio"),
    videoQueue: queue("video"),
  });
  return { controller, calls };
}

test("keeps buffered media when a recovery attaches the same track layout", async () => {
  const { controller, calls } = reusableController();

  await controller.attach(manifest, true);

  expect(calls).toEqual(["clear:audio", "clear:video"]);
});

test("still clears buffered media for an ordinary session attach", async () => {
  const { controller, calls } = reusableController();

  await controller.attach(manifest);

  expect(calls).toEqual(["reset:audio", "reset:video"]);
});

test("passes the buffer keeping request to the media attachment", async () => {
  const attachments: boolean[] = [];
  const ready = (sessionId: string): PlaybackWindow => ({
    sessionId,
    generation: 1,
    ready: true,
    retryAfterMs: null,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    status: "ready",
    blockedBy: null,
    bufferedEdgeMs: 120_000,
    startTimeMs: 90_000,
    manifest,
  });
  await loadPlayerSessionOnce({
    deps: {
      playback: {
        create: async () => response("unused"),
        position: async (sessionId) => ready(sessionId),
        prefetch: async (sessionId) => ready(sessionId),
        segments: async (sessionId) => ready(sessionId),
      },
      media: {
        attach: async (_manifest, keep) => {
          attachments.push(keep === true);
        },
        bufferedRanges: () => [],
      },
      scheduler: { appendInit: async () => undefined, fill: async () => "filled", reset: () => {} },
      policy: {
        bufferGoalMs: 10_000,
        backBufferMs: 30_000,
        pollIntervalMs: 500,
        manifestRefreshMs: 8_000,
        manifestPollLimit: 2,
        segmentPollLimit: 2,
      },
    },
    config: {
      endpoint: "https://example.test/api",
      videoId: "video",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: null,
    },
    video: { currentTime: 90, paused: true },
    response: response("fresh"),
    current: null,
    quality: undefined,
    startTimeMs: 90_000,
    signal: new AbortController().signal,
    recovery: new PlaybackRecovery(skipRecoveryDelay),
    keepBufferedMedia: true,
  });

  expect(attachments).toEqual([true]);
});

test("keeps buffered media only for the recovery operation of a network failure", () => {
  const network = harness(async () => response("fresh"));
  const decoder = harness(async () => response("fresh"));
  const state = (player: unknown) => player as { bufferKeepingRevision: number | null };

  network.player.handlePlaybackLoopError(recoveryError(), {
    sessionId: "source",
    signal: network.player.operation.signal,
  });
  decoder.player.handlePlaybackLoopError(new MediaElementPlaybackError(3), {
    sessionId: "source",
    signal: decoder.player.operation.signal,
  });

  expect(state(network.player).bufferKeepingRevision).toBe(1);
  expect(state(decoder.player).bufferKeepingRevision).toBeNull();
});
