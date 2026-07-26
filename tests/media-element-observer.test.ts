import { expect, test } from "bun:test";
import { MediaElementObserver, MediaElementPlaybackError } from "../src/media-element-observer";

test("keeps a handled MSE media error inside the player", () => {
  const video = media(3);
  let downstreamErrors = 0;
  const observer = new MediaElementObserver({
    video,
    state: () => undefined,
    progress: () => undefined,
    error: (error) => {
      expect(error).toBeInstanceOf(MediaElementPlaybackError);
      expect((error as MediaElementPlaybackError).code).toBe(3);
      return true;
    },
  });
  observer.start();
  video.addEventListener("error", () => {
    downstreamErrors += 1;
  });

  video.dispatchEvent(new Event("error"));

  expect(downstreamErrors).toBe(0);
  observer.stop();
});

test("passes an unhandled media error to the host player", () => {
  const video = media(4);
  let downstreamErrors = 0;
  const observer = new MediaElementObserver({
    video,
    state: () => undefined,
    progress: () => undefined,
    error: () => false,
  });
  observer.start();
  video.addEventListener("error", () => {
    downstreamErrors += 1;
  });

  video.dispatchEvent(new Event("error"));

  expect(downstreamErrors).toBe(1);
  observer.stop();
});

function media(errorCode: number): HTMLVideoElement {
  const video = new EventTarget() as HTMLVideoElement;
  Object.defineProperty(video, "error", { value: { code: errorCode } });
  Object.defineProperty(video, "currentTime", { value: 0, writable: true });
  return video;
}
