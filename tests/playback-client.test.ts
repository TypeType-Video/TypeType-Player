import { expect, test } from "bun:test";
import { type HttpClient, TypeTypeHttpError } from "../src/http-client";
import { PlaybackClient } from "../src/playback-client";
import { PlaybackWindowRecoveryError } from "../src/playback-window-error";

test("creates live playback sessions and parses live timing", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const http = {
    json: async (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      return {
        sessionId: "live-session",
        videoId: "X4VbdwhkE10",
        videoItag: 248,
        audioItag: 251,
        audioTrackId: "fr-FR.4",
        generation: 0,
        ready: true,
        retryAfterMs: null,
        startTimeMs: 3_590_000,
        live: {
          active: true,
          postLiveDvr: false,
          headSequence: 720,
          headTimeMs: 3_600_000,
          seekableStartMs: 0,
          seekableEndMs: 3_600_000,
          atLiveEdge: true,
          targetLatencyMs: 10_000,
        },
      };
    },
    absolute: (path: string) => `https://beta.typetype.video/api${path}`,
  } as unknown as HttpClient;

  const response = await new PlaybackClient(http).create({
    videoId: "X4VbdwhkE10",
    videoItag: 137,
    audioItag: 140,
    audioTrackId: null,
    startTimeMs: 0,
    audioOnly: false,
    isLive: true,
  });

  expect(requests[0]?.path).toContain("/sabr/playback/X4VbdwhkE10?");
  expect(requests[0]?.path).toContain("isLive=true");
  expect(requests[0]?.init?.method).toBe("POST");
  expect(response.videoItag).toBe(248);
  expect(response.audioItag).toBe(251);
  expect(response.audioTrackId).toBe("fr-FR.4");
  expect(response.startTimeMs).toBe(3_590_000);
  expect(response.live).toMatchObject({ active: true, headSequence: 720 });
});

test("turns an expired playback window into fresh session recovery", async () => {
  const http = {
    json: async () => {
      throw new TypeTypeHttpError("Not Found", 404);
    },
    absolute: (path: string) => `https://beta.typetype.video/api${path}`,
  } as unknown as HttpClient;

  const request = new PlaybackClient(http).position("expired", playbackWindowRequest());
  const error = await request.catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(PlaybackWindowRecoveryError);
  expect(error).toMatchObject({
    message: "Playback session expired",
    recoveryAction: "retry_fresh_session",
  });
});

test("does not mask unrelated playback window failures", async () => {
  const http = {
    json: async () => {
      throw new TypeTypeHttpError("Unauthorized", 401);
    },
    absolute: (path: string) => `https://beta.typetype.video/api${path}`,
  } as unknown as HttpClient;

  const request = new PlaybackClient(http).position("unauthorized", playbackWindowRequest());
  const error = await request.catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(TypeTypeHttpError);
  expect(error).toMatchObject({ status: 401 });
});

function playbackWindowRequest() {
  return {
    generation: 0,
    playerTimeMs: 420_000,
    videoItag: 137,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
    bufferGoalMs: 30_000,
    backBufferMs: 10_000,
    bufferedRanges: [],
  };
}
