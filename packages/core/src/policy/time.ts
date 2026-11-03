/**
 * Household-zone day boundaries (_specs/v2-m2-child.md section 8): a child request and the extra time
 * it grants last until the end of the child's day. Pure; uses Intl only, so it needs no tz database.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Milliseconds the zone is ahead of UTC at `at` (negative for the Americas). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(at)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The first instant of the next local day in `timeZone` (UTC when null or not a zone Intl knows): the
 * end of "today" for someone in that zone. Handles daylight-saving days (23 or 25 hours long).
 */
export function endOfLocalDay(now: Date, timeZone: string | null | undefined): Date {
  let zone = timeZone || "UTC";
  try {
    zoneOffsetMs(now, zone);
  } catch {
    zone = "UTC";
  }
  const offset = zoneOffsetMs(now, zone);
  const local = new Date(now.getTime() + offset);
  const nextMidnightWall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  let instant = nextMidnightWall - offset;
  // The offset can differ at the boundary (a DST change overnight): settle on the offset in force there.
  for (let i = 0; i < 2; i++) instant = nextMidnightWall - zoneOffsetMs(new Date(instant), zone);
  return new Date(instant);
}
