import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import type { MediaBufferedRange } from "../src/media-source-controller";
import {
  chooseHandoffMs,
  firstSegmentStartMs,
  planModeHandoff,
  waitForPlayhead,
} from "../src/mode-switch-handoff";

const audioTrack = {
  kind: "audio" as const,
  mime: 'audio/mp4; codecs="mp4a.40.2"',
  initUrl: "/audio/init",
  segments: [{ url: "/audio/7", startMs: 60_000, durationMs: 10_000 }],
};

function videoManifest(starts: number[]): PlaybackManifest {
  return {
    durationMs: 500_000,
    endOfStream: false,
    audio: audioTrack,
    video: {
      kind: "video",
      mime: 'video/mp4; codecs="avc1.640028"',
      initUrl: "/video/init",
      segments: starts.map((startMs) => ({ url: `/video/${startMs}`, startMs, durationMs: 5_000 })),
    },
  };
}

const audioManifest: PlaybackManifest = {
  durationMs: 500_000,
  endOfStream: false,
  audio: audioTrack,
  video: null,
};

function ranges(endMs: number): MediaBufferedRange[] {
  return [
    { kind: "audio", startMs: 50_000, endMs: endMs + 2_000 },
    { kind: "video", startMs: 50_000, endMs },
  ];
}

test("plans the swap ahead of the playhead inside what both tracks buffered", () => {
  expect(planModeHandoff(ranges(70_000), 61_000, ["audio", "video"])).toEqual({
    targetMs: 61_600,
    bufferedEndMs: 70_000,
  });
  expect(planModeHandoff(ranges(61_800), 61_000, ["audio", "video"])?.targetMs).toBe(61_550);
});

test("falls back to a plain switch when too little media is buffered", () => {
  expect(planModeHandoff(ranges(61_250), 61_000, ["audio", "video"])).toBeNull();
  expect(planModeHandoff([], 61_000, ["audio"])).toBeNull();
  expect(
    planModeHandoff([{ kind: "audio", startMs: 0, endMs: 60_000 }], 61_000, ["audio"]),
  ).toBeNull();
});

test("swaps to video on a nearby keyframe and otherwise right after the target", () => {
  const plan = { targetMs: 61_600, bufferedEndMs: 70_000 };
  expect(chooseHandoffMs(videoManifest([60_000, 62_500, 67_500]), plan, 61_000)).toBe(62_500);
  expect(chooseHandoffMs(videoManifest([60_000, 65_000]), plan, 61_000)).toBe(61_600);
  expect(chooseHandoffMs(audioManifest, plan, 61_000)).toBe(61_600);
});

test("swaps right away when preparing took longer than the buffered media", () => {
  expect(chooseHandoffMs(audioManifest, { targetMs: 61_600, bufferedEndMs: 62_000 }, 61_900)).toBe(
    61_900,
  );
});

test("waits for the playhead and reports a late or paused position", async () => {
  const signal = new AbortController().signal;
  const video = { currentTime: 61.5, paused: false, ended: false, readyState: 4 };
  setTimeout(() => (video.currentTime = 61.61), 15);
  expect(await waitForPlayhead(video, 61_600, signal)).toBe(61_600);
  expect(await waitForPlayhead({ ...video, currentTime: 61.9 }, 61_600, signal)).toBe(61_900);
  expect(await waitForPlayhead({ ...video, currentTime: 61.2, paused: true }, 61_600, signal)).toBe(
    61_200,
  );
});

test("swaps where the playhead stalls before reaching the swap point", async () => {
  const signal = new AbortController().signal;
  const stalled = { currentTime: 109.67, paused: false, ended: false, readyState: 2 };
  expect(await waitForPlayhead(stalled, 109_790, signal)).toBe(109_670);
});

test("stops waiting when the switch is cancelled", async () => {
  const controller = new AbortController();
  const wait = waitForPlayhead(
    { currentTime: 1, paused: false, ended: false, readyState: 4 },
    5_000,
    controller.signal,
  );
  controller.abort();
  await expect(wait).rejects.toThrow("Operation aborted");
});

test("finds where the new playback window starts", () => {
  expect(firstSegmentStartMs(videoManifest([59_000, 64_000]))).toBe(59_000);
  expect(firstSegmentStartMs(audioManifest)).toBe(60_000);
});
