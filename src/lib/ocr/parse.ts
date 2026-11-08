/**
 * Pure parsing helpers for OCR text read off physical MTG cards.
 * Kept free of any DOM/browser dependencies so they can be unit-tested in Node.
 */

export interface SetCodeParse {
  /** Modern set code as printed on the card, e.g. "MH3", "M49", "AER" */
  setCode: string;
  /** Collector number as printed, e.g. "259", alt-art "187A" (suffix uppercased), or superset form "20/270" */
  collectorNumber: string;
}

/**
 * The bottom-left corner of a modern MTG card prints the collector number on one
 * line (next to the set symbol) and the set code on the next line, e.g.:
 *
 *     ◈ 177
 *     MH3 · EN   JASON RAINVILLE
 *
 * OCR output is noisy, so each line is normalized before matching: uppercase,
 * alphanumerics/slashes/spaces only. Set codes are 2–5 letters/digits with at
 * least one letter (MH3, M49, AER, ONE); collector numbers are 1–4 digits,
 * optionally with an alt-art letter suffix and/or a "/superset" tail. OCR often
 * reads the number with a leading zero ("0216"), which is stripped.
 *
 * Older cards don't print this at all — callers should then fall back to
 * reading the card name from the top of the card.
 */
export function parseSetAndCollector(raw: string): SetCodeParse | null {
  if (!raw) return null;

  // Keep line structure — the number/code layout across lines is what we match on.
  const lines = raw
    .split(/\n+/)
    .map(l => l.toUpperCase().replace(/[^A-Z0-9/\s]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // Collector number: 1–4 digits + optional alt-art letter + optional "/superset"
  const NUMBER_RE = /\b(\d{1,4}[A-Z]?\/?\d{0,3})\b/g;

  interface Hit { line: number; value: string }
  const numbers: Hit[] = [];
  const codes: Hit[] = [];

  lines.forEach((line, li) => {
    for (const m of line.matchAll(NUMBER_RE)) numbers.push({ line: li, value: m[1] });

    // The set code is printed at the left edge of its line (before "EN" and the
    // artist credit), so only the first token of a line qualifies as a candidate.
    const firstTok = line.split(/\s+/).find(Boolean);
    if (firstTok && /^[A-Z0-9]{2,5}$/.test(firstTok) && /[A-Z]/.test(firstTok)) {
      // Two-letter tokens without a digit are language codes / noise ("EN")
      if (!(firstTok.length === 2 && !/\d/.test(firstTok))) {
        codes.push({ line: li, value: firstTok });
      }
    }
  });

  // Pair each number with its best nearby code candidate: on the same line or
  // the line directly below (the printed layout — the set code is never above
  // the number). A token can never be both, so identical pairs are rejected
  // (e.g. rules-text noise reading "4A" as one token). Ties break toward the
  // longer (more plausible) number.
  let best: { code: string; num: string; rank: number } | null = null;
  for (const n of numbers) {
    for (const c of codes) {
      if (c.line !== n.line && c.line !== n.line + 1) continue;
      if (c.value === n.value) continue;
      const rank = c.line === n.line ? 0 : 1;
      const better =
        !best ||
        rank < best.rank ||
        (rank === best.rank && n.value.length > best.num.length);
      if (better) {
        best = { code: c.value, num: n.value, rank };
      }
    }
  }

  if (best) {
    return { setCode: best.code, collectorNumber: stripLeadingZeros(best.num) };
  }

  // Last resort: OCR merged everything into one blob ("MH3259") — the token must
  // end in a digit and be followed by 2+ digits, so a bare "MH3" never matches.
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ');
  const compact = normalized.match(/\b([A-Z]+[0-9])(\d{2,4})\b/) ??
    normalized.match(/\b([A-Z]+[0-9]{2})(\d{2,4})\b/);

  // Letter-only set codes (e.g. "ONE259" → set ONE, #259): the compact pattern
  // above would greedily parse this as ONE2 + 59. If a letter-only interpretation
  // yields a longer collector number, prefer it (3-4 digit numbers are more
  // plausible than 2-digit ones for modern sets).
  const letterOnly = normalized.match(/\b([A-Z]{2,})(\d{3,4})\b/);
  if (letterOnly && (!compact || letterOnly[2].length > compact[2].length)) {
    return { setCode: letterOnly[1], collectorNumber: stripLeadingZeros(letterOnly[2]) };
  }

  if (compact) return { setCode: compact[1], collectorNumber: stripLeadingZeros(compact[2]) };

  return null;
}

/** "0216" -> "216", "020/270" -> "20/270" (OCR often glues a leading zero on). */
function stripLeadingZeros(num: string): string {
  const slash = num.indexOf('/');
  const main = slash === -1 ? num : num.slice(0, slash);
  const rest = slash === -1 ? '' : '/' + num.slice(slash + 1);
  return main.replace(/^0+(?=\d)/, '') + rest;
}

/**
 * Type-line fragments that can leak into the name-bar crop when OCR merges lines.
 * Card names never start with one of these followed by more text, so stripping a
 * leading occurrence is safe (e.g. "Lightning Bolt" is untouched).
 */
const TYPE_LINE_PREFIX_RE = /^(?:basic\s+land|creature|planeswalker|battle|instant|sorcery|artifact|enchantment|land)\b[\s\-–—]*/i;

/** Strips a trailing mana-cost token (e.g. "Lightning Strike 2R" -> "Lightning Strike"). */
const TRAILING_MANA_RE = /\s+\d*[WUBRG]{1,6}$/;

/** Whole lines that are just a mana cost ("3GW", "2R") or bare digits — never a card name. */
const NON_NAME_LINE_RE = /^(\d*[WUBRG]{1,6}|\d+)$/i;

function cleanNameLine(line: string): string | undefined {
  // Keep only characters that can appear in card names (letters incl. accents,
  // digits, spaces, apostrophes, commas, hyphens)
  let s = line
    .replace(/[^\p{L}\p{N},.'’\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return undefined;

  // Drop a type-line fragment or trailing mana cost if OCR merged them in
  s = s.replace(TYPE_LINE_PREFIX_RE, '').replace(TRAILING_MANA_RE, '').trim();
  if (s.length < 3) return undefined;

  return s;
}

/**
 * Extracts a card-name candidate from the OCR text of the top name-bar region.
 * The card name is always the first real text on the card — frame noise sits
 * above it and art texture below it — so the earliest word-like line wins:
 * only tokens of 4+ letters count toward the score (short fragments are
 * ignored rather than penalized, since OCR glues cost/icon garbage onto the
 * end of real name lines), and a line needs a score of at least 6.
 */
export function extractCardName(raw: string): string | undefined {
  if (!raw) return undefined;

  const lines = raw.split(/\n+/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Skip mana-cost / number-only lines (e.g. the cost printed right of the name bar)
    if (NON_NAME_LINE_RE.test(line.replace(/[^\p{L}\p{N}]/gu, ''))) continue;
    const name = cleanNameLine(line);
    if (!name) continue;

    let score = 0;
    for (const tok of name.split(/\s+/)) {
      const letters = (tok.match(/\p{L}/gu) ?? []).length;
      if (letters >= 4) score += letters;
    }
    if (score >= 6) return name;
  }

  return undefined;
}

/**
 * Picks the best card name from Scryfall search hits given an OCR'd reading.
 * Scores each candidate by how many of its words appear verbatim in the
 * reading (tokens shorter than 4 letters are ignored — they're usually noise);
 * ties break toward the shorter, more likely exact name. Returns null when no
 * candidate shares a word with the reading.
 */
export function pickBestNameMatch(ocrText: string, candidates: string[]): string | null {
  const tokens = new Set(
    ocrText.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4)
  );

  let best: { name: string; score: number } | null = null;
  for (const name of candidates) {
    const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    let score = 0;
    for (const w of words) if (tokens.has(w)) score++;
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && name.length < best.name.length)) {
      best = { name, score };
    }
  }

  return best?.name ?? null;
}
