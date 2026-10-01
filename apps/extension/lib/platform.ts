import { browser } from "wxt/browser";
import type { DevicePlatform } from "./types.js";

/**
 * `platform` (`_specs/browser-extension.md` "Package and build"): `navigator.userAgentData.brands`
 * when available (Chrome/Edge), else the Firefox build target from WXT's `import.meta.env.BROWSER`.
 * Edge installs the Chrome build from the Chrome Web Store, so it is detected at runtime rather
 * than built separately.
 */
export function detectPlatform(): DevicePlatform {
  if (import.meta.env.FIREFOX) return "firefox";
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands ?? [];
  if (brands.some((b) => b.brand.toLowerCase().includes("edge"))) return "edge";
  return "chrome";
}

/** A friendly default device name, editable by the person before enrolling. */
export function defaultDeviceName(platform: DevicePlatform): string {
  const os = navigator.platform || navigator.userAgent;
  let osName = "your computer";
  if (/win/i.test(os)) osName = "Windows";
  else if (/mac/i.test(os)) osName = "Mac";
  else if (/linux/i.test(os)) osName = "Linux";
  else if (/android/i.test(os)) osName = "Android";
  const browserName = platform === "firefox" ? "Firefox" : platform === "edge" ? "Edge" : "Chrome";
  return `${browserName} on ${osName}`;
}

/** The extension's own version, from the built manifest. */
export function clientVersion(): string {
  return browser.runtime.getManifest().version;
}
