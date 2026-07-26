import { expect, test } from "bun:test";
import { observePlaybackLifecycle } from "../src/playback-lifecycle-observer";

test("wakes playback from PiP media progress without relying on page timers", () => {
  const video = mediaTarget(true);
  const document = visibilityTarget("visible");
  let wakes = 0;
  const activity: boolean[] = [];
  const stop = observePlaybackLifecycle(
    {
      active: (active) => activity.push(active),
      wake: () => {
        wakes += 1;
      },
    },
    { document, video },
  );

  expect(activity).toEqual([true]);
  expect(wakes).toBe(1);
  video.dispatchEvent(new Event("timeupdate"));
  expect(wakes).toBe(1);
  video.dispatchEvent(new Event("enterpictureinpicture"));
  video.dispatchEvent(new Event("timeupdate"));
  video.dispatchEvent(new Event("leavepictureinpicture"));
  expect(wakes).toBe(4);

  video.dispatchEvent(new Event("timeupdate"));
  expect(wakes).toBe(4);
  stop();
});

test("suspends hidden paused playback and resumes it on play", () => {
  const video = mediaTarget(true);
  const document = visibilityTarget("hidden");
  const scheduled: Array<{ callback: () => void; cancelled: boolean }> = [];
  let wakes = 0;
  const activity: boolean[] = [];
  const stop = observePlaybackLifecycle(
    {
      active: (active) => activity.push(active),
      wake: () => {
        wakes += 1;
      },
    },
    {
      document,
      video,
      schedule: (callback) => {
        const entry = { callback, cancelled: false };
        scheduled.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    },
  );

  document.dispatchEvent(new Event("visibilitychange"));
  video.dispatchEvent(new Event("timeupdate"));
  video.dispatchEvent(new Event("waiting"));
  document.dispatchEvent(new Event("resume"));
  expect(activity).toEqual([false, false, false]);
  expect(wakes).toBe(0);

  video.paused = false;
  video.dispatchEvent(new Event("play"));
  for (const entry of scheduled.splice(0)) {
    if (!entry.cancelled) entry.callback();
  }
  video.dispatchEvent(new Event("timeupdate"));
  expect(activity).toEqual([false, false, false, true, true, true]);
  expect(wakes).toBe(4);

  stop();
  video.dispatchEvent(new Event("stalled"));
  expect(wakes).toBe(4);
});

test("rechecks lifecycle after WebKit page and orientation transitions", () => {
  const video = mediaTarget(true);
  const document = visibilityTarget("visible");
  const page = new EventTarget();
  const scheduled: Array<{ callback: () => void; cancelled: boolean }> = [];
  const activity: boolean[] = [];
  const stop = observePlaybackLifecycle(
    {
      active: (active) => activity.push(active),
      wake: () => undefined,
    },
    {
      document,
      page,
      video,
      schedule: (callback) => {
        const entry = { callback, cancelled: false };
        scheduled.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    },
  );

  page.dispatchEvent(new Event("orientationchange"));
  expect(activity).toEqual([true, true]);
  for (const entry of scheduled) entry.callback();
  expect(activity).toEqual([true, true, true, true]);

  page.dispatchEvent(new Event("pageshow"));
  stop();
  expect(scheduled.slice(2).every((entry) => entry.cancelled)).toBe(true);
});

function visibilityTarget(state: DocumentVisibilityState) {
  const target = new EventTarget() as EventTarget & {
    visibilityState: DocumentVisibilityState;
  };
  target.visibilityState = state;
  return target;
}

function mediaTarget(paused: boolean) {
  const target = new EventTarget() as EventTarget & { paused: boolean };
  target.paused = paused;
  return target;
}
