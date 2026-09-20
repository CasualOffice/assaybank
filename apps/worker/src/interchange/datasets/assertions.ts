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

/**
 * Which lines begin in code rather than part-way through a string or a bracket.
 *
 * Shared by both splitters below, because "is this line the start of a statement" is the only
 * question either of them asks of Python, and answering it twice would be two chances to
 * answer it differently.
 */
export function structuralLines(lines: readonly string[]): readonly boolean[] {
  let state: ScanState = { depth: 0, quote: null };
  return lines.map((line) => {
    const structural = state.depth === 0 && state.quote === null;
    state = scanLine(line, state);
    return structural;
  });
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
  const structuralAt = structuralLines(lines);

  let current: { lines: string[]; line: number } | null = null;

  lines.forEach((line, index) => {
    const starts = structuralAt[index] === true && ASSERT.test(line);

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

/** One `unittest` test method, lifted out with the class it belongs to. */
export interface TestMethod {
  /** The method name, `test_something`, used as the case label. */
  readonly name: string;
  /** The `def` line and its body, at their original indentation. */
  readonly code: string;
  /** 1-based line of the `def` within the file. */
  readonly line: number;
}

/** `class BobTest(unittest.TestCase):` at the top level. */
const CLASS = /^class\s+([A-Za-z_]\w*)\s*(\(|:)/u;
/** `    def test_something(self):`, at whatever indent the class body uses. */
const TEST_DEF = /^(\s+)def\s+(test\w*)\s*\(/u;

/**
 * Splits a `unittest` module into one case per test method.
 *
 * ## Why a method rather than an assertion here
 *
 * ADR-024's unit is the smallest thing that can be run and scored on its own, and for a
 * `unittest` file that is a method, not a statement. A method is what the framework
 * discovers, what `setUp` runs before, and what a name like `test_handles_empty_input`
 * describes; two `assertEqual` calls inside one are two halves of a single behaviour, and
 * pulling them apart would produce cases that fail for reasons their names do not explain
 * — and would break any that share a local built in the first line.
 *
 * Same discipline as the assertion splitter: this finds where a method begins and ends and
 * reads nothing inside it.
 */
export function splitTestMethods(source: string): {
  readonly preamble: string;
  readonly className: string | null;
  readonly methods: readonly TestMethod[];
} {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const structural = structuralLines(lines);

  const preamble: string[] = [];
  const methods: TestMethod[] = [];
  let className: string | null = null;
  let inClass = false;
  let current: { name: string; lines: string[]; line: number; indent: number } | null = null;

  const close = (): void => {
    if (current === null) return;
    const done = current;
    methods.push({
      name: done.name,
      code: done.lines.join('\n').trimEnd(),
      line: done.line,
    });
    current = null;
  };

  lines.forEach((line, index) => {
    const isStructural = structural[index] === true;

    if (isStructural && CLASS.test(line)) {
      close();
      // The first class wins. An Exercism test file has one; if a later one appears it is a
      // helper, and its methods are not the exercise's tests.
      if (className === null) className = CLASS.exec(line)?.[1] ?? null;
      inClass = true;
      return;
    }

    const def = isStructural ? TEST_DEF.exec(line) : null;
    if (def !== null && inClass) {
      close();
      current = {
        name: def[2] ?? 'test',
        lines: [line],
        line: index + 1,
        indent: (def[1] ?? '').length,
      };
      return;
    }

    if (current !== null) {
      const blank = line.trim() === '';
      const indent = line.length - line.trimStart().length;
      // A structural line at or left of the `def` ends the method: the next method, or
      // anything after the class. A blank line does not, because a method may contain one.
      if (!blank && isStructural && indent <= current.indent) {
        close();
        preamble.push(line);
        return;
      }
      current.lines.push(line);
      return;
    }

    if (!inClass) preamble.push(line);
  });

  close();

  return { preamble: preamble.join('\n').trimEnd(), className, methods };
}
