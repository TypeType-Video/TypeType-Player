import { expect, test } from "bun:test";
import type { EventEmitter } from "../src/event-emitter";
import type { HttpClient } from "../src/http-client";
import type { PlaybackManifest } from "../src/manifest";
import { MediaSourceController } from "../src/media-source-controller";
import { PlaybackLoop } from "../src/playback-loop";
import { SegmentScheduler } from "../src/segment-scheduler";
import type { LoadedSession } from "../src/session-loader";

function quotaError(): DOMException {
  return new DOMException("The SourceBuffer is full", "QuotaExceededError");
}

function controllerWithQueue(failures: number) {
  const calls: string[] = [];
  let remaining = failures;
  const video = { currentTime: 42 } as HTMLVideoElement;
  const controller = new MediaSourceController(video);
  const queue = {
    append: async () => {
      calls.push("append");
      if (remaining > 0) {
        remaining -= 1;
        throw quotaError();
      }
    },
    remove: async (start: number, end: number) => {
      calls.push(`remove:${start}-${end}`);
    },
  };
  (controller as unknown as { videoQueue: typeof queue }).videoQueue = queue;
  return { controller, calls };
}

test("evicts played media and retries an append that exceeded the quota", async () => {
  const { controller, calls } = controllerWithQueue(1);

  const result = await controller.append("video", new ArrayBuffer(1));

  expect(result).toBe("appended");
  expect(calls).toEqual(["append", "remove:0-40", "append"]);
});

test("defers an append that still exceeds the quota after eviction", async () => {
  const { controller, calls } = controllerWithQueue(2);

  const result = await controller.append("video", new ArrayBuffer(1));

  expect(result).toBe("deferred");
  expect(calls).toEqual(["append", "remove:0-40", "append"]);
});

const segments = [
  { url: "/1", startMs: 0, durationMs: 5_000 },
  { url: "/2", startMs: 5_000, durationMs: 5_000 },
];

function manifest(): PlaybackManifest {
  return {
    durationMs: 60_000,
    endOfStream: false,
    audio: { kind: "audio", mime: "audio/mp4", initUrl: "/init", segments },
    video: null,
  };
}

test("stops filling a track and refetches a deferred segment later", async () => {
  const requested: string[] = [];
  let deferNext = true;
  const http = {
    once: async (url: string) => {
      requested.push(url);
      return { status: 200, statusText: "OK", headers: new Headers(), body: new ArrayBuffer(1) };
    },
  } as unknown as HttpClient;
  const media = {
    append: async () => {
      if (!deferNext) return "appended" as const;
      deferNext = false;
      return "deferred" as const;
    },
    bufferedRanges: () => [],
  };
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);

  const first = await scheduler.fill(manifest(), 0, 10_000);
  const second = await scheduler.fill(manifest(), 0, 10_000);

  expect(first).toBe("deferred");
  expect(second).toBe("filled");
  expect(requested).toEqual(["/1", "/1", "/2"]);
});

test("trims behind the playhead before filling and shrinks the goal after a deferral", async () => {
  const calls: string[] = [];
  const goals: number[] = [];
  const session = {
    response: { sessionId: "session", videoId: "video", generation: 0, ready: true },
    manifest: { ...manifest(), endOfStream: true },
  } as unknown as LoadedSession;
  const loop = new PlaybackLoop({
    video: { currentTime: 100, paused: false, readyState: 4 },
    playback: {} as never,
    media: {
      bufferedRanges: () => [],
      endOfStream: () => {
        calls.push("endOfStream");
        return false;
      },
      trim: async () => {
        calls.push("trim");
      },
    },
    scheduler: {
      fill: async (_manifest, currentMs, goalMs) => {
        calls.push("fill");
        goals.push(goalMs - currentMs);
        return "deferred";
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
    bufferedEndMs: () => 110_000,
    error: (error) => {
      throw error;
    },
  });

  await loop.fillOnce();
  await loop.fillOnce();

  expect(calls).toEqual(["trim", "fill", "trim", "fill"]);
  expect(goals).toEqual([30_000, 15_000]);
});
