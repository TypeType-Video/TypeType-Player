import { expect, test } from "bun:test";
import { observePageSuspension, TransientMediaState } from "../src/transient-media-state";

test("restores the media element after a temporary override", () => {
  const video = videoElement();
  const state = new TransientMediaState(video);

  const restore = state.begin();
  expect(state.active).toBe(true);
  expect(video.muted).toBe(true);
  expect(video.style.opacity).toBe("0");
  expect(video.playbackRate).toBe(16);
  expect(video.autoplay).toBe(true);

  restore();
  expect(state.active).toBe(false);
  expect(video.muted).toBe(false);
  expect(video.style.opacity).toBe("0.75");
  expect(video.playbackRate).toBe(1.25);
  expect(video.autoplay).toBe(false);
});

test("preserves media preferences across a source replacement", () => {
  const video = videoElement();
  video.playbackRate = 4;
  const state = new TransientMediaState(video);

  const restore = state.preserve();
  video.muted = true;
  video.playbackRate = video.defaultPlaybackRate;
  expect(video.playbackRate).toBe(4);
  restore();

  expect(video.muted).toBe(false);
  expect(video.defaultPlaybackRate).toBe(1);
  expect(video.playbackRate).toBe(4);
});

test("keeps a source replacement hidden through decode preroll", () => {
  const video = videoElement();
  const state = new TransientMediaState(video);

  const restoreAttachment = state.beginAttachment();
  expect(video.style.opacity).toBe("0");
  expect(video.playbackRate).toBe(1.25);

  const finishPreroll = state.beginPreroll();
  expect(video.playbackRate).toBe(16);
  finishPreroll();
  expect(state.active).toBe(true);
  expect(video.style.opacity).toBe("0");

  restoreAttachment();
  expect(state.active).toBe(false);
  expect(video.muted).toBe(false);
  expect(video.style.opacity).toBe("0.75");
  expect(video.playbackRate).toBe(1.25);
});

test("an obsolete owner cannot restore a newer override", () => {
  const video = videoElement();
  const state = new TransientMediaState(video);
  const restoreFirst = state.begin();
  const restoreSecond = state.begin();

  restoreFirst();
  expect(state.active).toBe(true);
  expect(video.playbackRate).toBe(16);

  restoreSecond();
  expect(state.active).toBe(false);
  expect(video.playbackRate).toBe(1.25);
});

test("pagehide and freeze restore temporary state synchronously", () => {
  for (const eventType of ["pagehide", "freeze"]) {
    const page = new EventTarget();
    const document = new EventTarget();
    const video = videoElement();
    const state = new TransientMediaState(video);
    const stop = observePageSuspension(() => state.restore(), {
      document,
      window: page,
    });
    state.begin();

    (eventType === "pagehide" ? page : document).dispatchEvent(new Event(eventType));

    expect(state.active).toBe(false);
    expect(video.muted).toBe(false);
    expect(video.playbackRate).toBe(1.25);
    stop();
  }
});

test("removed lifecycle observers no longer restore state", () => {
  const page = new EventTarget();
  const video = videoElement();
  const state = new TransientMediaState(video);
  const stop = observePageSuspension(() => state.restore(), { window: page });
  stop();
  state.begin();

  page.dispatchEvent(new Event("pagehide"));

  expect(state.active).toBe(true);
});

function videoElement(): HTMLVideoElement {
  return {
    autoplay: false,
    defaultPlaybackRate: 1,
    muted: false,
    playbackRate: 1.25,
    style: { opacity: "0.75" },
  } as HTMLVideoElement;
}
