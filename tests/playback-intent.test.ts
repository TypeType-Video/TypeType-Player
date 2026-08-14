import { expect, test } from "bun:test";
import { PlaybackIntent } from "../src/playback-intent";

test("preserves playback intent while a seek replaces the media source", () => {
  const intent = new PlaybackIntent();
  intent.capture(false, false);
  intent.capture(true, true);
  expect(intent.shouldResume).toBe(true);
});

test("honors explicit pause and play during a seek", () => {
  const intent = new PlaybackIntent();
  intent.capture(false, false);
  intent.pause();
  expect(intent.shouldResume).toBe(false);
  intent.play();
  expect(intent.shouldResume).toBe(true);
});

test("applies a play request queued during a transition", async () => {
  const intent = new PlaybackIntent();
  let paused = true;
  let plays = 0;
  intent.play();
  const video = {
    get paused() {
      return paused;
    },
    pause: () => {
      paused = true;
    },
    play: async () => {
      plays += 1;
      paused = false;
    },
  } as HTMLVideoElement;

  await intent.apply(video);

  expect(plays).toBe(1);
  expect(video.paused).toBe(false);
});

test("applies a pause request queued during a transition", async () => {
  const intent = new PlaybackIntent();
  let paused = false;
  let pauses = 0;
  intent.pause();
  const video = {
    get paused() {
      return paused;
    },
    pause: () => {
      pauses += 1;
      paused = true;
    },
    play: async () => {
      paused = false;
    },
  } as HTMLVideoElement;

  await intent.apply(video);

  expect(pauses).toBe(1);
  expect(video.paused).toBe(true);
});

test("does not emit another pause when playback is already paused", async () => {
  const intent = new PlaybackIntent();
  let events = 0;
  intent.pause();
  const video = {
    paused: true,
    pause: () => {},
    play: async () => {},
    dispatchEvent: (event: Event) => {
      if (event.type === "pause") events += 1;
      return true;
    },
  } as unknown as HTMLVideoElement;

  await intent.apply(video);

  expect(events).toBe(0);
});
