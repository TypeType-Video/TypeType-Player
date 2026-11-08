import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import { createSeekStrategy, NativeSeekStrategy, PrerollSeekStrategy } from "../src/seek-strategy";
import { TransientMediaState } from "../src/transient-media-state";

const manifest: PlaybackManifest = {
  durationMs: 600_000,
  endOfStream: false,
  audio: {
    kind: "audio",
    mime: 'audio/mp4; codecs="mp4a.40.2"',
    initUrl: "/audio/init",
    segments: [
      { url: "/audio/0", startMs: 0, durationMs: 10_000 },
      { url: "/audio/1", startMs: 10_000, durationMs: 10_000 },
    ],
  },
  video: {
    kind: "video",
    mime: 'video/mp4; codecs="avc1.640028"',
    initUrl: "/video/init",
    segments: [
      { url: "/video/0", startMs: 0, durationMs: 10_000 },
      { url: "/video/1", startMs: 10_000, durationMs: 10_000 },
    ],
  },
};

test("factory creates PrerollSeekStrategy by default", () => {
  const strategy = createSeekStrategy();
  expect(strategy).toBeInstanceOf(PrerollSeekStrategy);
  expect(strategy.mode).toBe("preroll");
});

test("factory creates NativeSeekStrategy when mode is native", () => {
  const strategy = createSeekStrategy("native");
  expect(strategy).toBeInstanceOf(NativeSeekStrategy);
  expect(strategy.mode).toBe("native");
});

test("NativeSeekStrategy positions currentTime directly without muting or opacity mask", () => {
  const strategy = new NativeSeekStrategy();
  const video = {
    currentTime: 0,
    muted: false,
    style: { opacity: "1" },
    paused: true,
  } as unknown as HTMLVideoElement;
  const transientState = new TransientMediaState(video);

  strategy.alignSessionPosition({
    video,
    resolvedStartTimeMs: 14_500,
    manifest,
    finalizePausedSeek: true,
    shouldResume: false,
    transientMediaState: transientState,
  });

  expect(video.currentTime).toBe(14.5);
  expect(video.muted).toBe(false);
  expect(video.style.opacity).toBe("1");
  expect(transientState.active).toBe(false);
});

test("PrerollSeekStrategy positions to keyframe startMs and engages preroll hold", () => {
  const strategy = new PrerollSeekStrategy();
  const video = {
    currentTime: 0,
    muted: false,
    style: { opacity: "1" },
    paused: true,
  } as unknown as HTMLVideoElement;
  const transientState = new TransientMediaState(video);

  strategy.alignSessionPosition({
    video,
    resolvedStartTimeMs: 14_500,
    manifest,
    finalizePausedSeek: true,
    shouldResume: false,
    transientMediaState: transientState,
  });

  // Snaps to keyframe boundary at 10.0s (10000ms)
  expect(video.currentTime).toBe(10);
  // Holds for preroll: muted and opacity 0
  expect(video.muted).toBe(true);
  expect(video.style.opacity).toBe("0");
  expect(transientState.active).toBe(true);
});

test("NativeSeekStrategy executeSessionSeek completes immediately and returns null", async () => {
  const strategy = new NativeSeekStrategy();
  let played = false;
  const video = {
    currentTime: 14.5,
    muted: false,
    paused: true,
    play: async () => {
      played = true;
    },
  } as unknown as HTMLVideoElement;
  const transientState = new TransientMediaState(video);
  const controller = new AbortController();

  const pending = await strategy.executeSessionSeek({
    video,
    resolvedStartTimeMs: 14_500,
    manifest,
    signal: controller.signal,
    finalizePausedSeek: true,
    shouldResume: true,
    transientMediaState: transientState,
    fillBuffer: async () => {},
  });

  expect(pending).toBeNull();
  expect(played).toBe(false);
});
