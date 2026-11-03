"use client";

import { useState, type FormEvent } from "react";
import { WEB_CATEGORIES, WEEKDAYS, type DowntimeWindow, type Weekday, type WebCategory, type YoutubeLevel } from "@neo/verdict";
import { formatAppLines, formatDomainLines, parseAppLines, parseDomainLines } from "@/lib/child-settings-form";
import type { AgeBandName, ChildSettings, ChildView } from "@/lib/member-types";

const BAND_LABEL: Record<AgeBandName, string> = { under_10: "under 10", "10_13": "10 to 13", "14_17": "14 to 17" };
const CATEGORY_LABEL: Record<WebCategory, string> = {
  adult: "Adult content",
  gambling: "Gambling",
  weapons: "Weapons",
  self_harm: "Self-harm",
  drugs: "Drugs",
  proxy_vpn: "Proxies and VPNs",
  social: "Social media",
  games: "Games",
  streaming: "Streaming",
  dating: "Dating",
};
const DAY_LABEL: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const MAX_DOWNTIME = 6;

const field = "min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm";
const area = "w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-xs";
const primary = "min-h-11 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50";
const card = "space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-sm";

/** The body for PUT .../policy: whole sections, or null to go back to the age-band defaults. */
export type ChildPolicyBody = Record<string, unknown>;

/**
 * The owner's Child settings for one member: blocked categories, SafeSearch, site and app lists, screen
 * time and downtime. It saves whole sections (`web`, `apps`, `screenTime`); "Reset to age defaults" drops
 * the member's own copy so the defaults for the child's age apply again.
 */
export function ChildSettingsEditor({ child, memberName, busy, onSave }: { child: ChildView; memberName: string; busy: boolean; onSave: (body: ChildPolicyBody, done: string) => void }) {
  const s: ChildSettings = child.settings;
  const [categories, setCategories] = useState<WebCategory[]>(s.web.categories);
  const [safeSearch, setSafeSearch] = useState(s.web.safeSearch);
  const [youtube, setYoutube] = useState<YoutubeLevel>(s.web.youtubeRestricted);
  const [allow, setAllow] = useState(formatDomainLines(s.web.allow));
  const [block, setBlock] = useState(formatDomainLines(s.web.block));
  const [appBlock, setAppBlock] = useState(formatAppLines(s.apps.block));
  const [approved, setApproved] = useState(formatAppLines(s.apps.approved));
  const [requireApproval, setRequireApproval] = useState(s.apps.requireApproval);
  const [minutes, setMinutes] = useState<Record<Weekday, number | null>>(s.screenTime.dailyMinutes);
  const [downtime, setDowntime] = useState<DowntimeWindow[]>(s.screenTime.downtime);
  const [warn, setWarn] = useState(s.screenTime.warnMinutes);
  const [allowDuring, setAllowDuring] = useState(formatAppLines(s.screenTime.allowDuringDowntime));
  const [requestsTo, setRequestsTo] = useState(s.childRequestsTo);

  const toggleCategory = (c: WebCategory) => setCategories((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));
  const setDowntimeAt = (i: number, patch: Partial<DowntimeWindow>) => setDowntime((cur) => cur.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(
      {
        web: { categories, safeSearch, youtubeRestricted: youtube, allow: parseDomainLines(allow), block: parseDomainLines(block) },
        apps: { block: parseAppLines(appBlock), requireApproval, approved: parseAppLines(approved) },
        screenTime: { dailyMinutes: minutes, downtime, warnMinutes: warn, allowDuringDowntime: parseAppLines(allowDuring) },
        childRequestsTo: requestsTo,
      },
      "Child settings saved.",
    );
  };

  return (
    <form onSubmit={submit} className={card} aria-labelledby="child-settings-heading">
      <div className="space-y-1">
        <h2 id="child-settings-heading" className="text-sm font-semibold">
          Child settings
        </h2>
        <p className="text-xs text-muted">
          {child.bandAssumed
            ? `${memberName} has no birth year yet, so Neo uses the defaults for ages ${BAND_LABEL[child.band]}.`
            : child.adult
              ? `Born in ${child.birthYear}, ${memberName} is 18 or older. Neo uses the defaults for ages ${BAND_LABEL[child.band]}.`
              : `Defaults for ages ${BAND_LABEL[child.band]} (born in ${child.birthYear}).`}{" "}
          {child.customized ? "You have changed some settings." : "Everything below is a default; change what you like."} Time zone: {child.timeZone ?? "not set"}.
        </p>
      </div>

      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-semibold">Block these kinds of sites</legend>
        {WEB_CATEGORIES.map((c) => (
          <label key={c} className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" checked={categories.includes(c)} onChange={() => toggleCategory(c)} />
            <span>{CATEGORY_LABEL[c]}</span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-2">
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" checked={safeSearch} onChange={(e) => setSafeSearch(e.target.checked)} />
          <span>Turn on SafeSearch in search engines</span>
        </label>
        <label className="block space-y-1 text-sm">
          <span>YouTube restricted mode</span>
          <select value={youtube} onChange={(e) => setYoutube(e.target.value as YoutubeLevel)} className={field}>
            <option value="off">Off</option>
            <option value="moderate">Moderate</option>
            <option value="strict">Strict</option>
          </select>
        </label>
      </div>

      <label className="block space-y-1 text-sm">
        <span>Always allow these sites (one per line, such as school.example.edu)</span>
        <textarea value={allow} onChange={(e) => setAllow(e.target.value)} rows={3} className={area} spellCheck={false} />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Always block these sites (one per line)</span>
        <textarea value={block} onChange={(e) => setBlock(e.target.value)} rows={3} className={area} spellCheck={false} />
      </label>

      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} />
        <span>New apps need your approval before they can be opened</span>
      </label>
      <p className="text-xs text-muted">Apps, one per line: <code>Signer name | image.exe</code>, <code>image.exe</code>, or <code>bundle:com.example.app</code> on a Mac.</p>
      <label className="block space-y-1 text-sm">
        <span>Always block these apps</span>
        <textarea value={appBlock} onChange={(e) => setAppBlock(e.target.value)} rows={3} className={area} spellCheck={false} />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Apps you have approved</span>
        <textarea value={approved} onChange={(e) => setApproved(e.target.value)} rows={3} className={area} spellCheck={false} />
      </label>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold">Daily screen time</legend>
        {WEEKDAYS.map((d) => (
          <div key={d} className="flex min-h-11 flex-wrap items-center gap-3 text-sm">
            <span className="w-24">{DAY_LABEL[d]}</span>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={minutes[d] === null} onChange={(e) => setMinutes((cur) => ({ ...cur, [d]: e.target.checked ? null : 60 }))} />
              <span>No limit</span>
            </label>
            {minutes[d] !== null && (
              <label className="flex items-center gap-2">
                <span className="sr-only">{DAY_LABEL[d]} minutes</span>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  step={5}
                  value={minutes[d] ?? 0}
                  onChange={(e) => setMinutes((cur) => ({ ...cur, [d]: Math.max(0, Math.min(1440, Math.round(Number(e.target.value) || 0))) }))}
                  className="min-h-11 w-24 rounded-xl border border-border bg-surface px-3 text-sm"
                />
                <span>minutes</span>
              </label>
            )}
          </div>
        ))}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold">Downtime (devices lock)</legend>
        {downtime.length === 0 && <p className="text-xs text-muted">No downtime.</p>}
        {downtime.map((w, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <span>From</span>
              <input type="time" value={w.start} onChange={(e) => setDowntimeAt(i, { start: e.target.value })} className="min-h-11 rounded-xl border border-border bg-surface px-3" />
            </label>
            <label className="flex items-center gap-2">
              <span>until</span>
              <input type="time" value={w.end} onChange={(e) => setDowntimeAt(i, { end: e.target.value })} className="min-h-11 rounded-xl border border-border bg-surface px-3" />
            </label>
            <button type="button" onClick={() => setDowntime((cur) => cur.filter((_, j) => j !== i))} className="min-h-11 rounded-xl border border-border px-3 text-sm">
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={downtime.length >= MAX_DOWNTIME}
          onClick={() => setDowntime((cur) => [...cur, { start: "21:00", end: "07:00" }])}
          className="min-h-11 rounded-xl border border-border px-3 text-sm disabled:opacity-50"
        >
          Add downtime
        </button>
        <p className="text-xs text-muted">A window can run past midnight, such as 21:00 until 07:00.</p>
      </fieldset>

      <label className="block space-y-1 text-sm">
        <span>Warn this many minutes before time runs out</span>
        <input type="number" min={0} max={120} value={warn} onChange={(e) => setWarn(Math.max(0, Math.min(120, Math.round(Number(e.target.value) || 0))))} className={field} />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Apps that still work during downtime</span>
        <textarea value={allowDuring} onChange={(e) => setAllowDuring(e.target.value)} rows={2} className={area} spellCheck={false} />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Send {memberName}&apos;s requests to</span>
        <select value={requestsTo} onChange={(e) => setRequestsTo(e.target.value as "owners" | "helpers")} className={field}>
          <option value="owners">The household owners</option>
          <option value="helpers">Their helpers</option>
        </select>
      </label>

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={primary}>
          {busy ? "Saving…" : "Save child settings"}
        </button>
        <button
          type="button"
          disabled={busy || !child.customized}
          onClick={() => onSave({ web: null, apps: null, screenTime: null, childRequestsTo: null }, "Back to the defaults for this age.")}
          className="min-h-11 rounded-xl border border-border px-4 text-sm disabled:opacity-50"
        >
          Reset to age defaults
        </button>
      </div>
    </form>
  );
}
