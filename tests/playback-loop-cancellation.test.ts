import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import { PlaybackLoop } from "../src/playback-loop";
import type { LoadedSession } from "../src/session-loader";

const manifest: PlaybackManifest = {
  durationMs: 60_000,
  endOfStream: false,
  audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
};

test("quiesce aborts active loop I O and allows the replacement fill", async () => {
  let startFirstFill: (() => void) | null = null;
  const firstFillStarted = new Promise<void>((resolve) => (startFirstFill = resolve));
  const seenSignals: AbortSignal[] = [];
  let calls = 0;
  const loop = new PlaybackLoop({
    video: { currentTime: 0, paused: false, readyState: 4 },
    playback: {
      position: async () => {
        throw new Error("Unexpected position request");
      },
      prefetch: async () => {
        throw new Error("Unexpected prefetch request");
      },
      segments: async () => {
        throw new Error("Unexpected segments request");
      },
    },
    media: { bufferedRanges: () => [], endOfStream: () => false, trim: async () => undefined },
    scheduler: {
      fill: async (_manifest, _currentMs, _goalMs, signal) => {
        calls += 1;
        if (!signal) throw new Error("Missing loop cancellation signal");
        seenSignals.push(signal);
        if (calls > 1) return;
        startFirstFill?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Operation aborted", "AbortError")),
            { once: true },
          );
        });
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
    bufferedEndMs: () => 30_000,
    error: () => undefined,
  });

  const staleFill = loop.fillOnce().catch((error: unknown) => error);
  await firstFillStarted;
  await loop.quiesce();
  expect(seenSignals[0]?.aborted).toBe(true);
  expect(await staleFill).toBeInstanceOf(DOMException);

  loop.wake();
  await Bun.sleep(0);
  expect(calls).toBe(1);

  await loop.fillOnce();
  expect(calls).toBe(2);
  expect(seenSignals[1]?.aborted).toBe(false);

  loop.start();
  loop.wake();
  await Bun.sleep(0);
  loop.stop();
  expect(calls).toBe(3);
});

const session: LoadedSession = {
  response: {
    sessionId: "active-session",
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
