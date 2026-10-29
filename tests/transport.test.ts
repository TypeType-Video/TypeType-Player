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
      liveMaxLatencyDuration: 15,
      liveSyncDuration: 5,
      maxBufferLength: 24,
      maxMaxBufferLength: 50,
      progressive: false,
      startFragPrefetch: true,
      startLevel: 0,
      testBandwidth: false,
    });
    expect(config).not.toHaveProperty("liveBackBufferLength");
  });

  test("loads whole segments so AES-128 encrypted HLS can be decrypted", () => {
    const config = createHlsConfig<{ progressive: boolean }, object>({ FetchLoader: class {} });
    expect(config.progressive).toBe(false);
  });

  test("versions every opaque media request within a playback generation", () => {
    const config = createHlsConfig<{ fetchSetup: unknown }, object>({
      FetchLoader: class {},
      playbackKey: "generation-1",
    });
    const setup = config.fetchSetup as (
      context: { url: string },
      initParams: RequestInit,
    ) => Request;
    const url = "https://example.test/media/m1_0123456789abcdefghijklmn";

    expect(new URL(setup({ url }, {}).url).searchParams.get("playback")).toBe("generation-1-0");
    expect(new URL(setup({ url }, {}).url).searchParams.get("playback")).toBe("generation-1-1");
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
  test("waits longer than the dash.js default for a cold CDN first byte", () => {
    const settings = createDashSettings();

    expect(settings.fragmentRequestTimeout).toBeGreaterThan(20_000);
    expect(settings.fragmentRequestProgressTimeout).toBeGreaterThan(0);
  });

  test("maps the shared policy to dash.js settings", () => {
    expect(createDashSettings()).toEqual({
      fragmentRequestTimeout: 45_000,
      fragmentRequestProgressTimeout: 15_000,
      buffer: {
        bufferTimeAtTopQuality: 24,
        bufferTimeAtTopQualityLongForm: 24,
        bufferToKeep: 30,
      },
      retryAttempts: {
        MPD: 5,
        MediaSegment: 6,
        InitializationSegment: 6,
        IndexSegment: 6,
      },
      retryIntervals: {
        MPD: 1_500,
        MediaSegment: 1_500,
        InitializationSegment: 1_500,
        IndexSegment: 1_500,
      },
    });
  });
});
