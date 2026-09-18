export type ChannelTone = "facebook" | "ebay" | "amazon" | "other";

export type ChannelMark = {
  channel: string;
  letter: string;
  label: string;
  tone: ChannelTone;
};

export function normalizeChannel(channel: string): string {
  return channel.trim().toLowerCase();
}

export function channelMark(channel: string): ChannelMark | null {
  const raw = channel.trim();
  const c = raw.toLowerCase();
  if (!c || c === "floor") return null;
  if (c === "facebook" || c === "fb" || c.includes("facebook")) {
    return { channel: raw, letter: "F", label: "Facebook", tone: "facebook" };
  }
  if (c === "ebay") return { channel: raw, letter: "E", label: "eBay", tone: "ebay" };
  if (c === "amazon") return { channel: raw, letter: "A", label: "Amazon", tone: "amazon" };
  return { channel: raw, letter: c.slice(0, 1).toUpperCase(), label: raw, tone: "other" };
}

const TONE_ORDER: Record<ChannelTone, number> = { facebook: 0, ebay: 1, amazon: 2, other: 3 };

export function sortMarks(channels: string[]): ChannelMark[] {
  return channels
    .map(channelMark)
    .filter((m): m is ChannelMark => Boolean(m))
    .sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.letter.localeCompare(b.letter));
}

export function ChannelMarks({ channels }: { channels: string[] }) {
  const marks = sortMarks(channels);
  if (!marks.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {marks.map((mark) => (
        <span
          key={mark.channel}
          title={mark.label}
          className={`listing-mark listing-mark-${mark.tone}`}
          aria-label={`Listed on ${mark.label}`}
        >
          {mark.letter}
        </span>
      ))}
    </span>
  );
}

export function ChannelToggleRow({
  options,
  listed,
  onToggle,
  disabled,
}: {
  options: string[];
  listed: string[];
  onToggle: (channel: string, next: boolean) => void;
  disabled?: boolean;
}) {
  const on = new Set(listed.map(normalizeChannel));
  const marks = options.map(channelMark).filter((m): m is ChannelMark => Boolean(m));
  const seen = new Set<string>();
  const unique = marks.filter((m) => {
    const key = normalizeChannel(m.channel);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.letter.localeCompare(b.letter));
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {unique.map((mark) => {
        const active = on.has(normalizeChannel(mark.channel));
        return (
          <button
            key={mark.channel}
            type="button"
            disabled={disabled}
            className={`listing-mark listing-mark-${mark.tone} ${active ? "" : "listing-mark-off"}`}
            aria-pressed={active}
            aria-label={`${active ? "Unlist from" : "List on"} ${mark.label}`}
            onClick={() => onToggle(mark.channel, !active)}
          >
            {mark.letter}
            <span className="sr-only"> {mark.label}</span>
          </button>
        );
      })}
    </div>
  );
}
