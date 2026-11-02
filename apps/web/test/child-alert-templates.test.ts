/** Child-mode alert text (_specs/v2-m2-child.md section 3): templates only, plain language, fitting the alert columns, never carrying attacker text through. */
import { TAMPER_REASONS } from "@neo/verdict";
import { describe, expect, it } from "vitest";
import { formatAppLines, formatDomainLines, parseAppLines, parseDomainLines } from "@/lib/child-settings-form";
import { describePolicy } from "@/lib/policy-summary";
import { appApprovalAlertText, childRequestAlertText, protectionDisabledAlertText, selfHarmAttemptsAlertText } from "@/lib/server/alerts/templates";
import { renderChildModeOffEmail } from "@/lib/server/email/household-email";
import { childDefaults } from "@neo/core";

const fits = (t: { title: string; body: string }): void => {
  expect(t.title.length).toBeLessThanOrEqual(140);
  expect(t.body.length).toBeLessThanOrEqual(1000);
};

describe("alert templates for the Child kinds", () => {
  it("self_harm_attempts is high, kind, names nobody's sites, and points to help", () => {
    const t = selfHarmAttemptsAlertText("Sam", "Sam's PC");
    expect(t.severity).toBe("high");
    expect(t.title).toBe("Sam keeps running into blocked self-harm pages");
    expect(t.body).toMatch(/gentle check-in/);
    expect(t.body).toMatch(/988/);
    fits(t);
  });

  it("app_approval is medium and cleans and truncates the app name", () => {
    const t = appApprovalAlertText("Sam", "Sam's PC", "Roblox");
    expect(t).toMatchObject({ severity: "medium", title: 'Sam installed "Roblox" and it needs your approval' });
    expect(t.body).toMatch(/can't open it/);
    const long = appApprovalAlertText("Sam", "PC", `Evil\u0000\n${"x".repeat(500)}`);
    expect(long.title).not.toMatch(/\u0000|\n/);
    fits(long);
    expect(appApprovalAlertText("Sam", "PC", "   ").title).toMatch(/"an app"/);
  });

  it("child_request is medium for each kind and never includes the child's own words", () => {
    expect(childRequestAlertText("Sam", "more_time", "30").title).toBe("Sam is asking for 30 more minutes on the computer");
    expect(childRequestAlertText("Sam", "unblock_site", "example.com").title).toBe('Sam is asking for "example.com" to be unblocked');
    expect(childRequestAlertText("Sam", "install_app", null).title).toBe("Sam is asking for a new app to be allowed");
    for (const kind of ["more_time", "unblock_site", "install_app"] as const) {
      const t = childRequestAlertText("Sam", kind, "x");
      expect(t.severity).toBe("medium");
      fits(t);
    }
  });

  it("protection_disabled has plain text for every tamper reason, and Elder's wording is unchanged", () => {
    for (const reason of TAMPER_REASONS) {
      const t = protectionDisabledAlertText("Sam", "Sam's PC", reason, "high");
      expect(t.title).toBe("Sam's protection was turned off");
      expect(t.body).toMatch(/Sam's PC/);
      expect(t.body).toMatch(/Ask them whether they did this on purpose/);
      fits(t);
    }
    expect(protectionDisabledAlertText("Gran", "Gran's PC", "extension_uninstalled", "high").body).toBe(
      "Neo's browser protection was removed from Gran's PC. Gran is not protected there until it is turned back on. Ask them whether they did this on purpose, and be cautious if someone on the phone told them to.",
    );
    expect(protectionDisabledAlertText("Gran", "Gran's PC", "device_offline", "medium").body).toMatch(/has stopped reporting to Neo/);
  });
});

describe("Child-off email", () => {
  it("is templated and escapes names", () => {
    const mail = renderChildModeOffEmail({ memberName: "<b>Sam</b>", changedByName: null, url: "https://neo.example.test/settings/household/members/1" });
    expect(mail.subject).toBe("Child mode was turned off for <b>Sam</b>");
    expect(mail.html).not.toContain("<b>Sam</b>");
    expect(mail.html).toContain("&lt;b&gt;Sam&lt;/b&gt;");
    expect(mail.text).toMatch(/A household owner turned Child mode off/);
    expect(() => renderChildModeOffEmail({ memberName: "Sam", changedByName: "Pat", url: "javascript:alert(1)" })).toThrow();
  });
});

describe("Child settings text forms", () => {
  it("parses domains from lines, commas and spaces: lowercased, deduplicated, blanks dropped", () => {
    expect(parseDomainLines(" TikTok.com\n\ndiscord.com, tiktok.com  reddit.com;x.org ")).toEqual(["tiktok.com", "discord.com", "reddit.com", "x.org"]);
    expect(parseDomainLines("")).toEqual([]);
    expect(formatDomainLines(["a.com", "b.com"])).toBe("a.com\nb.com");
  });

  it("parses app lines in the three shapes and formats them back", () => {
    const text = "Roblox Corporation | RobloxPlayerBeta.exe\nnotepad.exe\nbundle:com.roblox.RobloxPlayer\n\nEpic Games, Inc. |";
    const apps = parseAppLines(text);
    expect(apps).toEqual([{ signer: "Roblox Corporation", image: "RobloxPlayerBeta.exe" }, { image: "notepad.exe" }, { bundleId: "com.roblox.RobloxPlayer" }, { signer: "Epic Games, Inc." }]);
    expect(parseAppLines(formatAppLines(apps))).toEqual(apps);
  });
});

describe("Child policy summary", () => {
  it("describes the defaults in plain words for each band", () => {
    const young = describePolicy("child", childDefaults("under_10")).join("\n");
    expect(young).toMatch(/Blocked web categories: adult content, gambling, weapons, self-harm, drugs, proxies and VPNs, social media, games, streaming, dating/);
    expect(young).toMatch(/SafeSearch is on, and YouTube is in strict restricted mode/);
    expect(young).toMatch(/New apps need your approval/);
    expect(young).toMatch(/Screen time: 1 hour on weekdays and 2 hours at weekends/);
    expect(young).toMatch(/Downtime: 19:30 to 07:00/);
    const teen = describePolicy("child", childDefaults("14_17")).join("\n");
    expect(teen).toMatch(/There is no daily screen-time limit/);
    expect(teen).toMatch(/New apps are allowed. Neo keeps a record of them/);
    expect(teen).toMatch(/Downtime: 23:00 to 06:00/);
  });

  it("says when screen time differs by day", () => {
    const rules = childDefaults("10_13");
    rules.screenTime!.dailyMinutes!.wed = 30;
    expect(describePolicy("child", rules).join("\n")).toMatch(/Screen time is set day by day/);
  });
});
