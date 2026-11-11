import type { DepScope } from "../types.js";

/** GitHub rejects a PR or issue body over 65536 characters; leave room. */
export const MAX_BODY_CHARS = 60000;

export const SCOPE_LABEL: Record<DepScope, string> = {
  production: "production",
  dev: "dev/test only",
  unknown: "undetermined",
};

// Left as written: a code span (paired backticks, matched left to right as markdown does)
// or a link, whose text is cleaned separately and whose destination is kept.
const SPAN = /`[^`]*`|\[([^\][]+)\]\(([^)\s]*)\)/g;
// A bare @name. Not preceded by a word character, so a@b.com stays an email.
const MENTION = /(?<!\w)@\w[^\s`]*/g;
// Punctuation that ends a sentence, not a name.
const TRAILING = ".,;:!?)]}'\"";

/** Text outside any span. A backtick left here is unpaired: it becomes ' so it can't open a span later. */
function plain(text: string): string {
  return text.replaceAll("`", "'").replace(MENTION, (token) => {
    let end = token.length;
    while (end > 1 && TRAILING.includes(token[end - 1])) end--;
    return `\`${token.slice(0, end)}\`${token.slice(end)}`;
  });
}

/**
 * Free text made safe for a bullet or table cell. Line breaks become spaces, so text
 * can't start a heading or a new row. A bare @name, which GitHub treats as a mention
 * and notifies, goes in backticks, so it stays copyable and tells nobody anything.
 */
export function inline(text: string): string {
  const flat = text.replace(/\r?\n|\r/g, " ");
  let out = "";
  let last = 0;
  for (const m of flat.matchAll(SPAN)) {
    out += plain(flat.slice(last, m.index));
    out += m[0].startsWith("`") ? m[0] : `[${inline(m[1])}](${m[2]})`;
    last = m.index + m[0].length;
  }
  return out + plain(flat.slice(last));
}

/** A table cell: safe free text, and no pipes that would split the row. */
export function cell(text: string): string {
  return inline(text).replace(/\|/g, "\\|");
}

export interface SummaryCounts {
  addressed: number;
  open: number;
  overridesAddedOrUpdated: number;
  overridesRemoved: number;
  packagesUpdated: number;
  /** Set to a baselinePhrase when packagesUpdated counts every package changed since that baseline. */
  packagesSince?: string;
  rangeBumps?: number;
  /** True when "packages updated" counts only what the update pass moved, not the override changes. */
  updatePassOnly: boolean;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * The one-line summary under a report's header. A plan leaves out the packages-updated
 * count, because nothing was installed to count.
 */
export function renderSummaryLine(c: SummaryCounts, planned: boolean): string {
  const parts = [
    `**${c.addressed}** of ${c.open} ${plural(c.open, "alert", "alerts")} addressed`,
    `**${c.overridesAddedOrUpdated}** ${plural(c.overridesAddedOrUpdated, "override", "overrides")} added or updated`,
  ];
  if (c.rangeBumps !== undefined) parts.push(`**${c.rangeBumps}** ${plural(c.rangeBumps, "range bump", "range bumps")}`);
  parts.push(`**${c.overridesRemoved}** removed`);
  if (!planned) {
    if (c.packagesSince !== undefined) {
      parts.push(`**${c.packagesUpdated}** ${plural(c.packagesUpdated, "package", "packages")} changed since ${c.packagesSince}`);
    } else {
      const packages = `**${c.packagesUpdated}** ${plural(c.packagesUpdated, "package", "packages")} updated`;
      parts.push(c.updatePassOnly ? `${packages} by the update pass` : packages);
    }
  }
  return (planned ? "Planned: " : "") + parts.join(" · ");
}
