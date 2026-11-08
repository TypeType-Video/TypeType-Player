import { expect, test } from "bun:test";
import {
  isPlaybackPermissionError,
  playMedia,
  tryResumePlayback,
  waitForNativeSeek,
} from "../src/media-playback";

test("resumes playback when the browser accepts the request", async () => {
  let plays = 0;
  const video = {
    pause: () => undefined,
    play: async () => {
      plays += 1;
    },
  };

  expect(await tryResumePlayback(video)).toBe(true);
  expect(plays).toBe(1);
});

test("keeps the media session when automatic playback needs a gesture", async () => {
  const error = new Error("User interaction is required");
  error.name = "NotAllowedError";
  const video = {
    pause: () => undefined,
    play: async () => {
      throw error;
    },
  };

  expect(isPlaybackPermissionError(error)).toBe(true);
  expect(await tryResumePlayback(video)).toBe(false);
});

test("propagates playback failures unrelated to browser permissions", async () => {
  const error = new Error("Decoder failed");
  error.name = "NotSupportedError";
  const video = {
    pause: () => undefined,
    play: async () => {
      throw error;
    },
  };

  expect(isPlaybackPermissionError(error)).toBe(false);
  await expect(tryResumePlayback(video)).rejects.toBe(error);
});

test("keeps an aborted pending play paused after Safari resolves it late", async () => {
  let release = () => undefined;
  let pauses = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const video = {
    pause: () => {
      pauses += 1;
    },
    play: () => pending,
  };

  const playback = playMedia(video, controller.signal);
  controller.abort();
  await expect(playback).rejects.toHaveProperty("name", "AbortError");
  expect(pauses).toBe(1);

  release();
  await pending;
  await Promise.resolve();
  expect(pauses).toBe(2);
});

test("waitForNativeSeek returns immediately when media is not seeking", async () => {
  const video = { seeking: false };
  await waitForNativeSeek(video);
});

test("waitForNativeSeek waits for seeked event", async () => {
  let listener: (() => void) | undefined;
  const video = {
    seeking: true,
    addEventListener: (type: string, cb: () => void) => {
      if (type === "seeked") listener = cb;
    },
    removeEventListener: () => undefined,
  };
  let resolved = false;
  const promise = waitForNativeSeek(video).then(() => {
    resolved = true;
  });
  expect(resolved).toBe(false);
  listener?.();
  await promise;
  expect(resolved).toBe(true);
});

test("waitForNativeSeek does not wait for a seek outside buffered media", async () => {
  const buffered = { length: 1, start: () => 0, end: () => 10 } as unknown as TimeRanges;
  const video = {
    seeking: true,
    currentTime: 22,
    buffered,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  await waitForNativeSeek(video);
  expect(video.seeking).toBe(true);
});

test("waitForNativeSeek stops waiting after its timeout", async () => {
  const video = {
    seeking: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  await waitForNativeSeek(video, undefined, 10);
  expect(video.seeking).toBe(true);
});
