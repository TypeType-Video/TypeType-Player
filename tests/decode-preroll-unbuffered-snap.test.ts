import { expect, test } from "bun:test";
import { runDecodePreroll } from "../src/decode-preroll";

test("defers an unbuffered snap without failing playback", async () => {
  let currentTime = 30.25;
  let paused = false;
  let seeking = false;
  let plays = 0;
  const video = {
    autoplay: false,
    buffered: {
      length: 1,
      start: () => 30.25,
      end: () => 40,
    },
    error: null,
    muted: false,
    playbackRate: 1,
    readyState: 2,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      seeking = true;
    },
    get paused() {
      return paused;
    },
    get seeking() {
      return seeking;
    },
    pause() {
      paused = true;
    },
    async play() {
      paused = false;
      plays += 1;
    },
  } as unknown as HTMLVideoElement;

  await runDecodePreroll(video, 30_000, true, new AbortController().signal);

  expect(currentTime).toBe(30);
  expect(video.seeking).toBe(true);
  expect(video.paused).toBe(false);
  expect(plays).toBe(1);
});
