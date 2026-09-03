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

/**
 * Split text into speakable lines, each tagged with its source line number.
 *
 * @param {string} text        the raw text
 * @param {number} firstLine   editor line number of the first line of `text`
 * @param {boolean} strip      whether to treat the text as source code
 * @returns {{speech: string, map: Array<{start: number, end: number, line: number}>}}
 *   `speech` is what gets spoken; `map` says which editor line each stretch of
 *   `speech` came from.
 */
function prepare(text, firstLine, strip) {
  const lines = text.split("\n");
  const map = [];
  let speech = "";

  lines.forEach((raw, offset) => {
    let line = raw;
    if (strip) {
      if (CODE_ONLY.test(line)) return;          // pure syntax, nothing to say
      line = line
        .replace(BLOCK_OPEN, "")
        .replace(LEADING_COMMENT, "")
        .replace(TRAILING_COMMENT, "");
    }
    if (!line.trim()) return;

    // How far into the original line the spoken text begins. Indentation and
    // any comment marker were removed, and the highlight has to put them back
    // to point at the right characters.
    const spoken = line.trim();
    const shift = raw.indexOf(spoken);

    const start = speech.length;
    speech += spoken;
    map.push({
      start,
      end: speech.length,
      line: firstLine + offset,
      shift: shift >= 0 ? shift : raw.length - raw.trimStart().length,
    });
    // The server splits into parts on blank lines. Separating every line this
    // way keeps parts small, so audio starts sooner and skipping is useful.
    speech += "\n\n";
  });

  return { speech: speech.trimEnd(), map };
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
