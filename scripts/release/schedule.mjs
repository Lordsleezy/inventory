/**
 * Production release clock. This is the only place the release time is defined.
 * Daily release workflow cron must stay equal to RELEASE_CRON.
 *
 * 6:00 America/Los_Angeles. GitHub cron is UTC and does not follow daylight
 * saving, so the workflow wakes at both 13:00 UTC (PDT) and 14:00 UTC (PST).
 * The job runs only when the local hour is 6 and skips the other wake-up.
 */
export const RELEASE_HOUR = 6;
export const RELEASE_TIME_ZONE = "America/Los_Angeles";
export const RELEASE_CRON = "0 13,14 * * *";

export function pacificParts(date, timeZone = RELEASE_TIME_ZONE) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    day: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** True when `date` is 6:00–6:59 in Pacific time (the scheduled release hour). */
export function isReleaseWindow(date, hour = RELEASE_HOUR, timeZone = RELEASE_TIME_ZONE) {
  const parts = pacificParts(date, timeZone);
  return parts.hour === hour;
}
