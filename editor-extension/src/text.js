// Turning editor text into something worth listening to.
//
// Source files are mostly punctuation. Reading "const x = {" aloud is noise,
// so comments lose their markers and lines that are pure syntax are dropped.
// Every kept line remembers which editor line it came from, so the highlight
// can point back at it.

/** Lines that carry no words worth speaking. */
const CODE_ONLY = /^[\s{}()[\];,.<>+\-*/%&|^!~?:=`'"\\]*$/;

/** Comment markers at the start of a line, in the languages people write in. */
const LEADING_COMMENT = /^\s*(\/\/+|#+|--|;+|%+|\*+|<!--)\s?/;
const TRAILING_COMMENT = /\s*(-->|\*\/)\s*$/;
const BLOCK_OPEN = /^\s*\/\*+\s?/;

/* Markdown marks up text with symbols that are meant to be seen, not heard.
   A heading's hashes, a bullet's dash and the stars around emphasis all have
   to go, or they get read out one by one. */
const MD_HEADING = /^\s{0,3}#{1,6}\s+/;
const MD_QUOTE = /^\s{0,3}>+\s?/;
const MD_BULLET = /^\s*([-*+]|\d{1,9}[.)])\s+/;
const MD_RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const MD_FENCE = /^\s{0,3}(```|~~~)/;
const MD_TRAILING_HASHES = /\s+#+\s*$/;

/**
 * Strip one line of Markdown down to the words in it.
 *
 * Only the marks at the edges are removed. What is inside a link or a bold
 * run is still the text someone wrote, so it stays.
 */
function stripMarkdown(line) {
  let out = line
    .replace(MD_HEADING, "")
    .replace(MD_QUOTE, "")
    .replace(MD_BULLET, "")
    .replace(MD_TRAILING_HASHES, "");

  // [what it says](where it goes) and ![alt](src): keep the words, drop the
  // address, which is not English and reads terribly.
  out = out.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  // [text][ref] and bare [text]
  out = out.replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1");

  // Emphasis and code marks around a run of text.
  out = out.replace(/\*\*\*(\S(?:.*?\S)?)\*\*\*/g, "$1");
  out = out.replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "$1");
  out = out.replace(/(?<![A-Za-z0-9_])___(\S(?:.*?\S)?)___(?![A-Za-z0-9_])/g, "$1");
  out = out.replace(/(?<![A-Za-z0-9_])__(\S(?:.*?\S)?)__(?![A-Za-z0-9_])/g, "$1");
  out = out.replace(/\*(\S(?:.*?\S)?)\*/g, "$1");
  // An underscore inside a name is part of the name, not emphasis.
  out = out.replace(/(?<![A-Za-z0-9_])_(\S(?:.*?\S)?)_(?![A-Za-z0-9_])/g, "$1");
  out = out.replace(/`+([^`]+)`+/g, "$1");
  out = out.replace(/~~(.+?)~~/g, "$1");

  // A table row is pipes and dashes holding cells apart.
  if (/^\s*\|/.test(out)) {
    if (/^[\s|:-]+$/.test(out)) return "";        // the divider row
    out = out.replace(/^\s*\|/, "").replace(/\|\s*$/, "").replace(/\s*\|\s*/g, ", ");
  }
  return out;
}

/**
 * Split text into speakable lines, each tagged with its source line number.
 *
 * @param {string} text        the raw text
 * @param {number} firstLine   editor line number of the first line of `text`
 * @param {"code"|"markdown"|"plain"} kind  how to clean each line
 * @returns {{speech: string, map: Array<{start: number, end: number, line: number, shift: number}>}}
 *   `speech` is what gets spoken; `map` says which editor line each stretch of
 *   `speech` came from, and how far into it the words start.
 */
function prepare(text, firstLine, kind) {
  const lines = text.split("\n");
  const map = [];
  let speech = "";

  // Backwards compatible: `true` used to mean "this is source code".
  const mode = kind === true ? "code" : kind === false ? "plain" : kind || "plain";
  let inFence = false;

  lines.forEach((raw, offset) => {
    let line = raw;

    if (mode === "code") {
      if (CODE_ONLY.test(line)) return;          // pure syntax, nothing to say
      line = line
        .replace(BLOCK_OPEN, "")
        .replace(LEADING_COMMENT, "")
        .replace(TRAILING_COMMENT, "");
    } else if (mode === "markdown") {
      // A fenced block is code someone pasted in. Reading it aloud is noise.
      if (MD_FENCE.test(line)) { inFence = !inFence; return; }
      if (inFence) return;
      if (MD_RULE.test(line)) return;            // a horizontal rule says nothing
      line = stripMarkdown(line);
    }

    if (!line.trim()) return;

    // Where each spoken character sits in the original line. Marks can be
    // taken out of the middle, not only the front, so one offset is not
    // enough to put the highlight back in the right place.
    const spoken = line.trim();
    const columns = mapColumns(raw, spoken);

    const start = speech.length;
    speech += spoken;
    map.push({
      start,
      end: speech.length,
      line: firstLine + offset,
      shift: columns.length ? columns[0] : raw.length - raw.trimStart().length,
      columns,
    });
    // The server splits into parts on blank lines. Separating every line this
    // way keeps parts small, so audio starts sooner and skipping is useful.
    speech += "\n\n";
  });

  return { speech: speech.trimEnd(), map };
}

/**
 * Line up the spoken text with the line it came from.
 *
 * Stripping removes marks from anywhere in the line, so this walks both
 * strings together and records, for each spoken character, which column of
 * the original it came from. Anything that cannot be lined up falls back to
 * the last column that could, which keeps the highlight close rather than
 * wrong by a wide margin.
 */
function mapColumns(raw, spoken) {
  const columns = [];
  let at = 0;
  for (const character of spoken) {
    const found = raw.indexOf(character, at);
    if (found < 0) {
      columns.push(at);              // not in the original: stay where we are
      continue;
    }
    columns.push(found);
    at = found + 1;
  }
  return columns;
}

/** Which editor line a character offset in the spoken text belongs to. */
function lineFor(map, offset) {
  let low = 0, high = map.length - 1, hit = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (map[mid].start <= offset) { hit = map[mid]; low = mid + 1; }
    else { high = mid - 1; }
  }
  return hit;
}

/** Strip everything but letters and digits, for matching spoken to written. */
function clean(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Match the server's word timings onto offsets in the spoken text.
 *
 * The server returns tokens with start and end times. It also returns
 * punctuation, which has no letters and so cannot be pointed at; those are
 * dropped. Matching is done on letters alone so that "hadn't" and "ninety-two"
 * stay whole.
 *
 * @returns {Array<{start: number, end: number, s: number, e: number}>}
 */
function alignWords(partStart, partText, words) {
  const spans = [];
  let cursor = 0;

  for (const word of words) {
    const target = clean(word.t !== undefined ? word.t : word.text);
    if (!target) continue;                    // punctuation: nothing to point at

    let found = -1;
    let stop = cursor;
    for (let i = cursor; i < partText.length; i++) {
      if (clean(partText[i]) !== target[0]) continue;
      let built = "";
      let j = i;
      while (j < partText.length && built.length < target.length) {
        built += clean(partText[j]);
        j++;
      }
      if (built === target) { found = i; stop = j; break; }
    }
    if (found < 0) continue;

    cursor = stop;
    spans.push({
      start: partStart + found,
      end: partStart + stop,
      s: word.s !== undefined ? word.s : word.start,
      e: word.e !== undefined ? word.e : word.end,
    });
  }
  return spans;
}

/**
 * Find each part the server returned inside the spoken text.
 *
 * The server may reflow whitespace, so matching is done on letters alone.
 * Returns the character offset of each part, or null if it cannot be placed.
 */
function locateParts(speech, texts) {
  const flat = [];
  const index = [];                 // index[i] = offset in `speech` of flat[i]
  for (let i = 0; i < speech.length; i++) {
    const c = clean(speech[i]);
    if (c) { flat.push(c); index.push(i); }
  }
  const haystack = flat.join("");

  const found = [];
  let from = 0;
  for (const text of texts) {
    const needle = clean(text);
    if (!needle) { found.push(null); continue; }
    const at = haystack.indexOf(needle, from);
    if (at < 0) { found.push(null); continue; }
    from = at + needle.length;
    found.push({ start: index[at], text });
  }
  return found;
}

module.exports = { prepare, lineFor, alignWords, locateParts, clean };
