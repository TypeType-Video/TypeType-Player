import { expect, test } from "bun:test";
import { BufferedSeekRecovery, nudgeStalledBufferedSeek } from "../src/buffered-seek-recovery";
import { MediaElementPlaybackError } from "../src/media-element-observer";

test("nudges an unresolved buffered seek without replacing media", () => {
  const media = seekMedia(true, 35.1, [[7.92, 59]]);

  expect(nudgeStalledBufferedSeek(media, 35_100)).toBe(true);
  expect(media.currentTime).toBe(35.2);
});

test("leaves completed and unbuffered seeks unchanged", () => {
  const completed = seekMedia(false, 35.1, [[7.92, 59]]);
  const unbuffered = seekMedia(true, 35.1, [[60, 90]]);

  expect(nudgeStalledBufferedSeek(completed, 35_100)).toBe(false);
  expect(nudgeStalledBufferedSeek(unbuffered, 35_100)).toBe(false);
  expect(completed.currentTime).toBe(35.1);
  expect(unbuffered.currentTime).toBe(35.1);
});

test("completes after the browser keeps the buffered seek stable", async () => {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  let cancelled = false;
  let recovered = 0;
  const media = seekMedia(true, 35.1, [[7.92, 59]]);
  const recovery = new BufferedSeekRecovery((callback, delayMs) => {
    scheduled.push({ callback, delayMs });
    return () => {
      cancelled = true;
    };
  });

  const completion = recovery.arm(
    media,
    35_100,
    () => {
      recovered += 1;
    },
    async () => undefined,
  );
  media.seeking = false;
  media.dispatchEvent(new Event("seeked"));
  scheduled.find((task) => task.delayMs === 100)?.callback();
  await completion;

  expect(cancelled).toBe(true);
  expect(recovered).toBe(0);
  expect(media.currentTime).toBe(35.1);
});

test("recovers one decoder failure after a completed buffered seek", async () => {
  let release = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const targets: number[] = [];
  const media = seekMedia(true, 35.1, [[7.92, 59]]);
  const recovery = new BufferedSeekRecovery(() => () => undefined);
  const completion = recovery.arm(
    media,
    35_100,
    () => undefined,
    (targetMs, freshMediaSource) => {
      targets.push(targetMs, Number(freshMediaSource));
      return pending;
    },
  );

  expect(recovery.handleDecoderError(new MediaElementPlaybackError(3))).toBe(true);
  expect(recovery.handleDecoderError(new MediaElementPlaybackError(3))).toBe(true);
  release();
  await completion;
  await Bun.sleep(0);

  expect(targets).toEqual([35_100, 1]);
  expect(recovery.handleDecoderError(new MediaElementPlaybackError(3))).toBe(false);
});

test("does not consume unrelated media errors", () => {
  const recovery = new BufferedSeekRecovery(() => () => undefined);
  const completion = recovery.arm(
    seekMedia(true, 35.1, [[7.92, 59]]),
    35_100,
    () => undefined,
    async () => undefined,
  );

  expect(recovery.handleDecoderError(new MediaElementPlaybackError(4))).toBe(false);
  void completion.catch(() => undefined);
  recovery.cancel();
});

test("falls back to a server seek when a buffered seek remains stuck", async () => {
  let fallback: (() => void) | null = null;
  const freshMediaSource: boolean[] = [];
  const recovery = new BufferedSeekRecovery((callback, delayMs) => {
    if (delayMs === 1_500) fallback = callback;
    return () => undefined;
  });
  const completion = recovery.arm(
    seekMedia(true, 35.1, [[7.92, 59]]),
    35_100,
    () => undefined,
    async (_targetMs, fresh) => {
      freshMediaSource.push(fresh);
    },
  );

  fallback?.();
  await completion;

  expect(freshMediaSource).toEqual([false]);
});

function seekMedia(seeking: boolean, currentTime: number, ranges: Array<[number, number]>) {
  const media = new EventTarget() as EventTarget & {
    buffered: TimeRanges;
    currentTime: number;
    seeking: boolean;
  };
  media.currentTime = currentTime;
  media.seeking = seeking;
  media.buffered = {
    length: ranges.length,
    start: (index: number) => ranges[index]?.[0] ?? 0,
    end: (index: number) => ranges[index]?.[1] ?? 0,
  };
  return media;
}
