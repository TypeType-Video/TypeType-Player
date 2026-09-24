import { describe, expect, test } from "bun:test";
import {
  createDashSettings,
  createHlsConfig,
  createHlsPlaybackKey,
  hlsRequestUrl,
  isMediaHandleUrl,
} from "../src/transport";

describe("HLS transport", () => {
  test("starts on the smallest level without a bandwidth test round trip", () => {
    const config = createHlsConfig<{ startLevel: number }, object>({
      FetchLoader: class {},
    });

    expect(config).toMatchObject({
      abrEwmaDefaultEstimate: 1_000_000,
      backBufferLength: 30,
      capLevelToPlayerSize: true,
      liveMaxLatencyDuration: 20,
      liveSyncDuration: 10,
      maxBufferLength: 24,
      maxMaxBufferLength: 50,
      progressive: true,
      startFragPrefetch: true,
      startLevel: 0,
      testBandwidth: false,
    });
    expect(config).not.toHaveProperty("liveBackBufferLength");
  });

  test("versions opaque media handles by playback generation", () => {
    const handle = "/media/m1_0123456789abcdefghijklmn";
    expect(isMediaHandleUrl(handle)).toBe(true);
    expect(hlsRequestUrl(handle, "generation-1")).toBe(`${handle}?playback=generation-1`);
    expect(hlsRequestUrl("https://example.test/video.m3u8", "generation-1")).toBe(
      "https://example.test/video.m3u8",
    );
  });

  test("keeps a transport key when secure randomness is unavailable", () => {
    const cryptoApi = {
      getRandomValues: (values: Uint32Array) => {
        values.set([1, 35, 171, 0xffffffff]);
        return values;
      },
    } as unknown as Crypto;

    expect(createHlsPlaybackKey(cryptoApi)).toBe("00000001-00000023-000000ab-ffffffff");
  });
});

describe("DASH transport", () => {
  test("maps the shared policy to dash.js settings", () => {
    expect(createDashSettings()).toEqual({
      buffer: {
        bufferTimeAtTopQuality: 24,
        bufferTimeAtTopQualityLongForm: 24,
        bufferToKeep: 30,
      },
      retryAttempts: {
        MPD: 5,
        MediaSegment: 3,
        InitializationSegment: 3,
        IndexSegment: 3,
      },
      retryIntervals: {
        MPD: 500,
        MediaSegment: 500,
        InitializationSegment: 500,
        IndexSegment: 500,
      },
    });
  });
});
