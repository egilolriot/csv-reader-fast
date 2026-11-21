// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference CSV reader).
//
// Same answer as csv-reader 1.0.0 for every input {text, header}:
// {columns, rows, errors}. Written from the published broken-row policy
// (RULES.txt), not by copying the reference implementation.
//
// Speed idea: the reference walks one character at a time and builds every
// field a character at a time. This parser instead jumps with the native
// indexOf (C++ speed) from one delimiter to the next and cuts each field
// out with one slice. The slow, character-wise paths only run where the
// input is actually broken (a stray CR, a doubled quote, a line break
// inside quotes, junk after a closing quote), which the generator draws
// rarely (each broken kind well under 1% of records).
//
// Delimiter search is kept bounded on purpose: an unquoted field is cut
// at the nearer of the next comma / LF (both found inside the field), and
// a CR inside the cut is only looked for inside that cut, never with an
// unbounded indexOf over the rest of the text (a file that uses LF only
// would otherwise rescan the whole tail on every field).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows
  // (null for the header). Errors name the record they belong to.
  let recordLine = 1;
  let recordRow = null;

  // Scratch for one field's result, so the field readers do not allocate.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line
  // break. A CR not followed by LF is dropped (stray_cr). Sets the
  // scratch: {fValue, fEnded, fAdded}; `added` counts characters kept.
  function readUnquoted(value, added) {
    const iC = text.indexOf(',', pos);
    const iL = text.indexOf('\n', pos);
    let end;
    let ended;
    let nextPos;
    if (iC !== -1 && (iL === -1 || iC < iL)) {
      end = iC;
      ended = COMMA;
      nextPos = iC + 1;
    } else if (iL !== -1) {
      end = iL;
      ended = LINE_BREAK;
      nextPos = iL + 1;
    } else {
      end = n;
      ended = END;
      nextPos = n;
    }
    const seg = text.slice(pos, end);
    if (seg.indexOf('\r') === -1) {
      // Fast path: no CR in the field at all. An empty `value` keeps the
      // cut itself instead of building a copy of it.
      pos = nextPos;
      if (ended === LINE_BREAK) line += 1;
      fValue = value === '' ? seg : value + seg;
      fEnded = ended;
      fAdded = added + seg.length;
      return;
    }
    // Slow path: the field holds CRs. Only the CR immediately before a
    // LF terminator is the CRLF half of that terminator; every other CR
    // is stray: dropped, one stray_cr error each.
    let v = value;
    let a = added;
    for (let i = 0; i < seg.length; i++) {
      if (seg.charCodeAt(i) === 13) {
        if (ended === LINE_BREAK && i === seg.length - 1) continue;
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      } else {
        v += seg[i];
        a += 1;
      }
    }
    pos = nextPos;
    if (ended === LINE_BREAK) line += 1;
    fValue = v;
    fEnded = ended;
    fAdded = a;
  }

  // Appends one stretch of a quoted field to `value`, counting the line
  // breaks it holds and reading each CRLF or lone CR inside it as one LF.
  function appendSegment(value, seg) {
    if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) return value + seg;
    let breaks = 0;
    for (let i = 0; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      if (c === 13) breaks += 1;
      else if (c === 10 && seg.charCodeAt(i - 1) !== 13) breaks += 1;
    }
    line += breaks;
    return value + seg.replace(/\r\n?/g, '\n');
  }

  // Reads a quoted field whose opening quote is at pos. Sets the scratch.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let p = pos + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"', 0);
        return;
      }
      const seg = text.slice(p, q);
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        // Doubled quote: one literal quote, and the field goes on.
        value = appendSegment(value, seg) + '"';
        p = q + 2;
        continue;
      }
      // Closing quote.
      value = appendSegment(value, seg);
      pos = q + 1;
      if (pos >= n) {
        fValue = value;
        fEnded = END;
        fAdded = 0;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        fAdded = 0;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = 0;
        return;
      }
      if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to
      // the next comma or line break (quote_junk, when the field ends).
      readUnquoted(value, 0);
      if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('', 0);
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
