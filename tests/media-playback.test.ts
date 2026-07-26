import { expect, test } from "bun:test";
import { isPlaybackPermissionError, tryResumePlayback } from "../src/media-playback";

test("resumes playback when the browser accepts the request", async () => {
  let plays = 0;
  const video = {
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
    play: async () => {
      throw error;
    },
  };

  expect(isPlaybackPermissionError(error)).toBe(false);
  await expect(tryResumePlayback(video)).rejects.toBe(error);
});
