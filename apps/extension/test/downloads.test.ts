import { describe, expect, it } from "vitest";
import { basename, matchDownload } from "../lib/detectors/downloads.js";
import { listsSnapshot } from "../lib/listsSnapshot.js";

const tools = listsSnapshot.remoteAccessTools;

describe("basename", () => {
  it("extracts the filename from a URL path", () => {
    expect(basename("https://example.com/dl/AnyDesk.exe?ref=123")).toBe("AnyDesk.exe");
  });

  it("extracts the filename from a bare filesystem path (Windows or POSIX separators)", () => {
    expect(basename("C:\\Users\\me\\Downloads\\AnyDesk.exe")).toBe("AnyDesk.exe");
    expect(basename("/home/me/Downloads/AnyDesk.exe")).toBe("AnyDesk.exe");
  });
});

describe("matchDownload", () => {
  it("matches an installer pattern from a non-vendor domain, using the referrer's domain", () => {
    const match = matchDownload(
      { filename: "AnyDesk.exe", url: "https://cdn.example.net/files/AnyDesk.exe", referrer: "https://totally-legit-support.example/download" },
      tools,
    );
    expect(match).toEqual({ toolId: "anydesk", toolName: "AnyDesk", fileName: "AnyDesk.exe", domain: "totally-legit-support.example" });
  });

  it("does not match when the referrer is the tool's own vendor domain", () => {
    const match = matchDownload({ filename: "AnyDesk.exe", url: "https://download.anydesk.com/AnyDesk.exe", referrer: "https://anydesk.com/download" }, tools);
    expect(match).toBeNull();
  });

  it("falls back to the download URL's domain when there is no referrer", () => {
    const match = matchDownload({ filename: "AnyDesk.exe", url: "https://sketchy-mirror.example/AnyDesk.exe" }, tools);
    expect(match?.domain).toBe("sketchy-mirror.example");
  });

  it("does not match an unrelated filename", () => {
    const match = matchDownload({ filename: "vacation-photos.zip", url: "https://example.com/vacation-photos.zip" }, tools);
    expect(match).toBeNull();
  });

  it("matches patterns only against the first 128 characters (a bound on a hostile pattern's cost)", () => {
    // The truncated name no longer ends in ".exe", so `^AnyDesk.*\.exe$` no longer matches: an
    // unusually long filename is a case the safety bound accepts missing, not a bug.
    const longName = `AnyDesk-${"a".repeat(200)}.exe`;
    const match = matchDownload({ filename: longName, url: "https://cdn.example.net/x", referrer: "https://totally-legit-support.example/" }, tools);
    expect(match).toBeNull();

    // A long-but-under-128-character name that still ends in ".exe" is still caught.
    const stillMatches = `AnyDesk-${"a".repeat(90)}.exe`; // 102 characters
    const shortEnoughMatch = matchDownload({ filename: stillMatches, url: "https://cdn.example.net/x", referrer: "https://totally-legit-support.example/" }, tools);
    expect(shortEnoughMatch?.toolId).toBe("anydesk");
    expect(shortEnoughMatch?.fileName.length).toBeLessThanOrEqual(128);
  });
});
