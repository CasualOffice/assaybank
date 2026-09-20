/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Splitting a block of Python assertions into one assertion per case (ADR-024).
 *
 * ## What this does and does not do
 *
 * It finds **statement boundaries**. It does not interpret anything: no expression is parsed,
 * no value is extracted, no comparison is understood. That distinction is the whole reason
 * ADR-024 chose `assertion_code` over converting these datasets to stdin/stdout — the moment
 * an importer starts reading what `assert f(a, b) == c` *means*, it is interpreting Python
 * with a regular expression, and MBPP alone will hand it `math.isclose`, unordered sets and
 * nested structures.
 *
 * Finding where one statement ends and the next begins is a different and much smaller job:
 * track string literals and bracket depth, and a line beginning `assert` at depth zero
 * outside a string starts a new one. Nothing else about the source matters.
 *
 * ## The failure mode is loud, and that was the point
 *
 * If the scan ever gets a boundary wrong, the result is a syntactically invalid assertion that
 * fails to run — an error at execution time, not a wrong score. Compare the alternative, where
 * a mis-parsed expected value produces a case that runs perfectly and marks a correct answer
 * wrong. A loud failure is recoverable; a quiet one is a candidate's rejection.
 *
 * ## Why one assertion rather than one block
 *
 * Each case carries its own `weight`, so per-assertion cases give partial credit over the
 * arithmetic that already exists, and a candidate can be told which assertion failed. The
 * whole block as one case would be one pass-or-fail for an eight-assertion problem.
 */

/** One assertion, with whatever setup precedes it in the block. */
export interface SplitAssertion {
  /** The assertion statement, including any continuation lines. */
  readonly code: string;
  /** 1-based line of the assertion within the block, for a problem message. */
  readonly line: number;
}

/** Quote runs that open a Python string, longest first so a triple quote wins. */
const QUOTES = ['"""', "'''", '"', "'"] as const;

/**
 * True when `line` begins an `assert` statement in code rather than inside a string.
 *
 * `state` is the scanner's carry from the previous line: the bracket depth it ended on and the
 * quote run it was inside, if any.
 */
interface ScanState {
  depth: number;
  /** The quote run currently open, or null. */
  quote: string | null;
}

/** Advances the scanner over one line, returning the state after it. */
function scanLine(line: string, state: ScanState): ScanState {
  let { depth, quote } = state;

  for (let i = 0; i < line.length; i += 1) {
    if (quote !== null) {
      // Inside a string: only its own closing run, or a backslash escape, matters.
      if (line[i] === '\\') {
        i += 1;
        continue;
      }
      if (line.startsWith(quote, i)) {
        i += quote.length - 1;
        quote = null;
      }
      continue;
    }

    // A comment runs to the end of the line and cannot contain anything structural.
    if (line[i] === '#') break;

    const opened = QUOTES.find((q) => line.startsWith(q, i));
    if (opened !== undefined) {
      quote = opened;
      i += opened.length - 1;
      continue;
    }

    const char = line[i];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
  }

  // A trailing backslash continues the logical line, which the caller sees as depth.
  return { depth: line.trimEnd().endsWith('\\') ? Math.max(depth, 1) : depth, quote };
}

/** `assert` as a statement: the word, then whitespace or end of line. */
const ASSERT = /^\s*assert(\s|$)/u;

/**
 * Every assertion in `block`, in order.
 *
 * Lines before the first assertion are returned separately as `preamble` — a dataset's test
 * block usually opens with imports or a fixture class, and every assertion needs them.
 */
export function splitAssertions(block: string): {
  readonly preamble: string;
  readonly assertions: readonly SplitAssertion[];
} {
  const lines = block.replace(/\r\n?/gu, '\n').split('\n');
  const preamble: string[] = [];
  const assertions: SplitAssertion[] = [];

  let state: ScanState = { depth: 0, quote: null };
  let current: { lines: string[]; line: number } | null = null;

  lines.forEach((line, index) => {
    const structural = state.depth === 0 && state.quote === null;
    const starts = structural && ASSERT.test(line);

    if (starts) {
      if (current !== null) {
        assertions.push({ code: current.lines.join('\n').trimEnd(), line: current.line });
      }
      current = { lines: [line], line: index + 1 };
    } else if (current !== null) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }

    state = scanLine(line, state);
  });

  if (current !== null) {
    const last = current as { lines: string[]; line: number };
    assertions.push({ code: last.lines.join('\n').trimEnd(), line: last.line });
  }

  return { preamble: preamble.join('\n').trimEnd(), assertions };
}

/**
 * Removes the common leading indentation from a block.
 *
 * HumanEval's assertions live inside `def check(candidate):`, so they arrive indented by four
 * spaces. Lifted out of that function they have to lose it, or they are a syntax error.
 * Measured over non-blank lines only, because a blank line inside a block has no indentation
 * to contribute and would otherwise force the common prefix to zero.
 */
export function dedent(block: string): string {
  const lines = block.split('\n');
  const widths = lines
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length);
  const common = widths.length === 0 ? 0 : Math.min(...widths);
  return lines.map((line) => (line.trim() === '' ? line : line.slice(common))).join('\n');
}
