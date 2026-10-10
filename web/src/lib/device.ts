import type { DeviceInfo } from "@webdrop/shared/protocol";

/** Coarse device description sent to the server (enums only, no raw UA). */
export function detectDevice(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints ?? 0): DeviceInfo {
  const iPadOs = /Macintosh/.test(ua) && touchPoints > 1;
  const os: DeviceInfo["os"] = /Android/i.test(ua)
    ? "android"
    : /iPhone|iPad|iPod/i.test(ua) || iPadOs
      ? "ios"
      : /CrOS/.test(ua)
        ? "chromeos"
        : /Windows/i.test(ua)
          ? "windows"
          : /Mac OS X|Macintosh/i.test(ua)
            ? "macos"
            : /Linux/i.test(ua)
              ? "linux"
              : "other";
  const browser: DeviceInfo["browser"] = /Edg(e|A|iOS)?\//.test(ua)
    ? "edge"
    : /OPR\/|Opera/.test(ua)
      ? "opera"
      : /SamsungBrowser/.test(ua)
        ? "samsung"
        : /Firefox|FxiOS/.test(ua)
          ? "firefox"
          : /Chrome|CriOS|Chromium/.test(ua)
            ? "chrome"
            : /Safari/.test(ua)
              ? "safari"
              : "other";
  const form: DeviceInfo["form"] =
    /iPad/.test(ua) || iPadOs || (os === "android" && !/Mobile/.test(ua)) ? "tablet" : /iPhone|iPod|Mobile/.test(ua) ? "mobile" : "desktop";
  return { os, browser, form };
}

const OS_LABEL: Record<DeviceInfo["os"], string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  chromeos: "ChromeOS",
  android: "Android",
  ios: "iOS",
  other: "Unknown OS",
};
const BROWSER_LABEL: Record<DeviceInfo["browser"], string> = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  safari: "Safari",
  opera: "Opera",
  samsung: "Samsung Internet",
  other: "Browser",
};

export const describeDevice = (d: DeviceInfo): string => `${OS_LABEL[d.os]} · ${BROWSER_LABEL[d.browser]}`;
