import { RoomCode } from "@webdrop/shared/protocol";
import { describe, expect, it } from "vitest";
import { describeDevice, detectDevice } from "../src/lib/device.ts";
import { normalizeCode } from "../src/lib/pairing.ts";
import { chunkSizeFor, tuning } from "../src/lib/tuning.ts";
import { formatBytes, formatEta, formatRate } from "../src/ui/format.ts";

describe("device detection", () => {
  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", 0, { os: "macos", browser: "chrome", form: "desktop" }],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", 5, { os: "ios", browser: "safari", form: "tablet" }],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1", 5, { os: "ios", browser: "safari", form: "mobile" }],
    ["Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36", 5, { os: "android", browser: "chrome", form: "mobile" }],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0", 0, { os: "windows", browser: "edge", form: "desktop" }],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", 0, { os: "linux", browser: "firefox", form: "desktop" }],
    ["Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", 0, { os: "chromeos", browser: "chrome", form: "desktop" }],
  ])("%s", (ua, touch, expected) => {
    expect(detectDevice(ua, touch)).toEqual(expected);
  });

  it("describes devices for display", () => {
    expect(describeDevice({ os: "macos", browser: "safari", form: "desktop" })).toBe("macOS · Safari");
  });
});

describe("pairing codes", () => {
  it("normalizes typing variations into the canonical alphabet", () => {
    expect(normalizeCode("ab-c 12o")).toBe("ABC120");
    expect(normalizeCode("il0o")).toBe("1100");
    expect(RoomCode.safeParse(normalizeCode("x7k-9q2")).success).toBe(true);
  });
});

describe("chunk sizing", () => {
  it("respects the remote SCTP max message size", () => {
    expect(chunkSizeFor(262144)).toBe(tuning.chunkSize);
    expect(chunkSizeFor(65536)).toBe(65536 - 28);
    expect(chunkSizeFor(1 << 30)).toBe(tuning.chunkSize);
    expect(chunkSizeFor(undefined)).toBe(16 * 1024 - 28);
    expect(chunkSizeFor(0)).toBe(16 * 1024 - 28);
  });
});

describe("formatting", () => {
  it("formats sizes, rates and ETAs", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1500)).toBe("1.5 KB");
    expect(formatBytes(123_456_789)).toBe("123 MB");
    expect(formatRate(25_000_000)).toBe("25.0 MB/s");
    expect(formatEta(50_000_000, 25_000_000)).toBe("2 s left");
    expect(formatEta(3_000_000_000, 25_000_000)).toBe("2 min left");
    expect(formatEta(10, 0)).toBe("");
  });
});
