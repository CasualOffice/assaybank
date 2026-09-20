/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the subset actually does.
 *
 * `xss-corpus.test.ts` proves nothing dangerous comes out. This proves something useful does
 * — that an author who writes ordinary markdown in a prompt gets what they meant, because a
 * renderer that is safe and wrong is still wrong, and the way it goes wrong is a candidate
 * reading a paragraph of unrendered pipes during a timed assessment.
 */

import { describe, expect, it } from 'vitest';

import { type Block, type Inline } from './ast.js';
import { parseMarkdown } from './index.js';

const blocks = (source: string): readonly Block[] => parseMarkdown(source).blocks;
const first = (source: string): Block | undefined => blocks(source)[0];

/** The text of a node tree, with code spans marked so a test can tell them apart. */
function render(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.value;
        case 'code':
          return `<code>${node.value}</code>`;
        case 'strong':
          return `<b>${render(node.children)}</b>`;
        case 'emphasis':
          return `<i>${render(node.children)}</i>`;
        case 'link':
          return `<a ${node.href}>${render(node.children)}</a>`;
        case 'image':
          return `<img ${node.src} alt=${node.alt}>`;
        case 'break':
          return '\n';
      }
    })
    .join('');
}

const inlineOf = (source: string): string => {
  const block = first(source);
  return block?.type === 'paragraph' ? render(block.children) : '';
};

describe('inline', () => {
  it('reads emphasis and strong emphasis', () => {
    expect(inlineOf('**bold** and *italic*')).toBe('<b>bold</b> and <i>italic</i>');
  });

  it('leaves a lone asterisk alone, which is what SQL needs', () => {
    // The list screen's first excerpt helper stripped every asterisk and quietly turned
    // `count(*)` into `count()` in every SQL question in the bank.
    expect(inlineOf('SELECT count(*) FROM applicants')).toBe('SELECT count(*) FROM applicants');
    expect(inlineOf('2 * 3 * 4')).toBe('2 * 3 * 4');
  });

  it('leaves underscores inside a word alone, which is what identifiers need', () => {
    expect(inlineOf('the max_score_delta column')).toBe('the max_score_delta column');
  });

  it('reads a code span, and the code span wins over the markup inside it', () => {
    expect(inlineOf('Use `a *b* c` here')).toBe('Use <code>a *b* c</code> here');
  });

  it('lets a code span hold a backtick', () => {
    expect(inlineOf('`` ` ``')).toBe('<code>`</code>');
  });

  it('honours a backslash escape', () => {
    expect(inlineOf('\\*not italic\\*')).toBe('*not italic*');
  });

  it('reads a link and an image', () => {
    expect(inlineOf('[docs](https://example.com)')).toBe('<a https://example.com>docs</a>');
    expect(inlineOf('![a schema](/s.png)')).toBe('<img /s.png alt=a schema>');
  });

  it('discards a link title, which is a tooltip no keyboard reaches', () => {
    expect(inlineOf('[docs](https://example.com "the docs")')).toBe(
      '<a https://example.com>docs</a>',
    );
  });

  it('joins a soft line break with a space and keeps a hard one', () => {
    expect(inlineOf('one\ntwo')).toBe('one two');
    expect(inlineOf('one  \ntwo')).toBe('one\ntwo');
    expect(inlineOf('one\\\ntwo')).toBe('one\ntwo');
  });

  it('leaves an unmatched bracket as text rather than eating the sentence', () => {
    expect(inlineOf('an array[0] of values')).toBe('an array[0] of values');
    expect(inlineOf('[unclosed')).toBe('[unclosed');
  });
});

describe('blocks', () => {
  it('reads headings at every level', () => {
    const block = first('### Constraints');
    expect(block).toMatchObject({ type: 'heading', level: 3 });
    expect(first('# One')).toMatchObject({ level: 1 });
    expect(first('###### Six')).toMatchObject({ level: 6 });
  });

  it('does not read seven hashes as a heading', () => {
    expect(first('####### seven')?.type).toBe('paragraph');
  });

  it('reads a fenced code block with its language, verbatim', () => {
    const block = first('```sql\nSELECT *\n  FROM t;\n```');

    expect(block).toEqual({ type: 'code', language: 'sql', value: 'SELECT *\n  FROM t;' });
  });

  it('keeps markdown inside a fence as source text', () => {
    const block = first('```\n# not a heading\n- not a list\n```');

    expect(block).toMatchObject({ type: 'code', value: '# not a heading\n- not a list' });
  });

  it('closes an unclosed fence at the end of the document', () => {
    expect(first('```\nstill code')).toEqual({ type: 'code', language: null, value: 'still code' });
  });

  it('refuses a language name that is not a plain identifier', () => {
    // It ends up in a class name. Restricting it here means no downstream escaping.
    expect(first('```js"><script>\nx\n```')).toMatchObject({ language: null });
  });

  it('reads an unordered list, with the item content parsed as blocks', () => {
    const block = first('- first\n- **second**');

    expect(block?.type).toBe('list');
    if (block?.type !== 'list') return;
    expect(block.ordered).toBe(false);
    expect(block.items).toHaveLength(2);
    expect(block.items[1]?.[0]).toMatchObject({ type: 'paragraph' });
  });

  it('reads an ordered list and keeps the number it starts at', () => {
    const block = first('3. third\n4. fourth');

    expect(block).toMatchObject({ type: 'list', ordered: true, start: 3 });
  });

  it('reads a nested list as blocks inside the parent item', () => {
    const block = first('- outer\n  - inner');

    expect(block?.type).toBe('list');
    if (block?.type !== 'list') return;
    expect(block.items[0]?.[1]).toMatchObject({ type: 'list' });
  });

  it('reads a thematic break rather than a bullet with no content', () => {
    expect(first('***')).toEqual({ type: 'rule' });
    expect(first('---')).toEqual({ type: 'rule' });
  });

  it('reads a blockquote, recursively', () => {
    const block = first('> quoted **text**\n> over two lines');

    expect(block?.type).toBe('quote');
    if (block?.type !== 'quote') return;
    expect(block.children[0]).toMatchObject({ type: 'paragraph' });
  });

  it('reads a table with alignment, and keeps it rectangular', () => {
    const block = first('| Col | Type |\n| :-- | ---: |\n| id | uuid |\n| a |');

    expect(block?.type).toBe('table');
    if (block?.type !== 'table') return;
    expect(block.align).toEqual(['left', 'right']);
    expect(block.head.map(render)).toEqual(['Col', 'Type']);
    expect(block.rows.map((row) => row.map(render))).toEqual([
      ['id', 'uuid'],
      // A short row is padded rather than dropped: a screen reader announces the column
      // header with each cell, and a ragged row makes those announcements wrong.
      ['a', ''],
    ]);
  });

  it('does not read a line of pipes as a table without a delimiter row', () => {
    expect(first('a | b | c')?.type).toBe('paragraph');
  });

  it('separates paragraphs on a blank line', () => {
    expect(blocks('one\n\ntwo')).toHaveLength(2);
  });

  it('lets a heading interrupt a paragraph, so a missed blank line is not fatal', () => {
    expect(blocks('text\n# Heading').map((b) => b.type)).toEqual(['paragraph', 'heading']);
  });

  it('is total — every input yields a document', () => {
    for (const source of ['', '   ', '\n\n', '[', '```', '|', '> > >', '- ', '#']) {
      expect(() => parseMarkdown(source)).not.toThrow();
    }
  });

  it('reads CRLF source as the same document as LF source', () => {
    expect(blocks('# A\r\n\r\ntext')).toEqual(blocks('# A\n\ntext'));
  });
});

describe('a realistic prompt', () => {
  const PROMPT = [
    'Given the table below, write a query that returns the **three** most recent',
    'applications per role.',
    '',
    '| Column | Type |',
    '| --- | --- |',
    '| `id` | uuid |',
    '| `created_at` | timestamptz |',
    '',
    'Notes:',
    '',
    '- Ties are broken by `id`.',
    '- `count(*)` over the whole table is not acceptable.',
    '',
    '```sql',
    'SELECT * FROM applications;',
    '```',
    '',
    'See [the schema](https://example.com/schema) for the rest.',
  ].join('\n');

  it('parses into the blocks it looks like', () => {
    expect(blocks(PROMPT).map((b) => b.type)).toEqual([
      'paragraph',
      'table',
      'paragraph',
      'list',
      'code',
      'paragraph',
    ]);
  });

  it('refuses nothing in it', () => {
    const doc = parseMarkdown(PROMPT);

    expect(doc.rawHtml).toEqual([]);
    expect(doc.rejectedUrls).toEqual([]);
  });
});
