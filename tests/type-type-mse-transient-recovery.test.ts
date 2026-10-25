import { expect, test } from "bun:test";
import { TypeTypeHttpError } from "../src/http-client";
import { PlaybackWindowTimeoutError } from "../src/playback-window-error";
import { harness, response } from "./type-type-mse-recovery-harness";

test("recovers a playback window timeout with a fresh session at the current position", async () => {
  const { player, requests, failures } = harness(async () => response("fresh"));

  player.handlePlaybackLoopError(new PlaybackWindowTimeoutError(), {
    sessionId: "source",
    signal: player.operation.signal,
  });
  await Bun.sleep(0);

  expect(requests.map((request) => request.startTimeMs)).toEqual([379_441]);
  expect(failures).toEqual([]);
  expect(player.session?.response.sessionId).toBe("fresh");
});

test("recovers a rate limited playback window with a fresh session", async () => {
  const { player, requests, failures } = harness(async () => response("fresh"));

  player.handlePlaybackLoopError(new TypeTypeHttpError("Too Many Requests", 429, 5_000), {
    sessionId: "source",
    signal: player.operation.signal,
  });
  await Bun.sleep(0);

  expect(requests).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("reports a playback window timeout once the recovery budget is spent", async () => {
  const { player, failures } = harness(async () => {
    throw new PlaybackWindowTimeoutError();
  });

  player.handlePlaybackLoopError(new PlaybackWindowTimeoutError(), {
    sessionId: "source",
    signal: player.operation.signal,
  });
  await Bun.sleep(0);

  expect(failures.map((error) => error.name)).toEqual(["PlaybackWindowTimeoutError"]);
});
