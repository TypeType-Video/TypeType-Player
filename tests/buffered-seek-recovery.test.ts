import { expect, test } from "bun:test";
import { BufferedSeekRecovery, nudgeStalledBufferedSeek } from "../src/buffered-seek-recovery";

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

test("cancels recovery after the browser completes the seek", () => {
  let scheduled: (() => void) | null = null;
  let cancelled = false;
  let recovered = 0;
  const media = seekMedia(true, 35.1, [[7.92, 59]]);
  const recovery = new BufferedSeekRecovery((callback) => {
    scheduled = callback;
    return () => {
      cancelled = true;
    };
  });

  recovery.arm(media, 35_100, () => {
    recovered += 1;
  });
  media.seeking = false;
  media.dispatchEvent(new Event("seeked"));
  scheduled?.();

  expect(cancelled).toBe(true);
  expect(recovered).toBe(0);
  expect(media.currentTime).toBe(35.1);
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
