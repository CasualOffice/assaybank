/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  parseMarkdown,
  type Block,
  type ColumnAlign,
  type Inline,
  type MarkdownDocument,
} from '@assaybank/markdown';
import { Fragment, type ReactNode, useMemo } from 'react';

import { cx } from './class-names.js';

/**
 * The one component that renders author-supplied markdown, in both apps.
 *
 * There is no `dangerouslySetInnerHTML` here, and there is none anywhere downstream of here —
 * `no-danger.test.ts` asserts the string appears nowhere in this package or either front end.
 * That is the whole of the XSS defence for question content (T-038, ADR-022): the parser
 * produces a closed union of nodes, this function is a total mapping from that union to React
 * elements, and React escapes every text node it is given. A prompt containing `<script>`
 * reaches the page as eight characters of text, because at no point did a string of markup
 * exist for a browser to parse.
 *
 * The switch below is exhaustive over `Block` and `Inline` with no `default` branch, so
 * adding a node type to the union without deciding how to render it does not compile.
 */

/** Props for {@link Markdown}. */
export interface MarkdownProps {
  /** The author's markdown. Parsed on change, memoised in between. */
  source: string;
  /**
   * The heading level a top-level `#` becomes. Default 3.
   *
   * A prompt is rendered inside a page that already has an `<h1>` and usually an `<h2>`, and
   * SC 1.3.1 is about the document's heading outline rather than each fragment's. An `<h1>`
   * emitted from inside a prompt would give the page two, which is how a screen-reader user
   * navigating by heading ends up believing they have reached a different page.
   */
  headingLevel?: 2 | 3 | 4 | 5;
  /**
   * How an external link behaves. `new-tab` is right in the candidate runner, where
   * navigating away means leaving a timed attempt; `same-tab` is right in the console.
   */
  externalLinks?: 'new-tab' | 'same-tab';
  className?: string;
}

/** A destination that leaves our origin, and therefore wants the new-tab treatment. */
function isExternal(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+\-.]*:/u.test(href) || href.startsWith('//');
}

const ALIGN_CLASS: Readonly<Record<'left' | 'center' | 'right', string>> = {
  left: 'ab-md__cell--left',
  center: 'ab-md__cell--center',
  right: 'ab-md__cell--right',
};

const alignClass = (align: ColumnAlign): string | false => align !== null && ALIGN_CLASS[align];

function InlineNodes({
  nodes,
  externalLinks,
}: {
  nodes: readonly Inline[];
  externalLinks: 'new-tab' | 'same-tab';
}): ReactNode {
  return nodes.map((node, index) => {
    // Nodes have no identity of their own and the list is regenerated wholesale from the
    // source on every change, so the index is the key. There is nothing to reorder.
    const key = index;
    switch (node.type) {
      case 'text':
        // A fragment rather than a span: an extra inline element between two words is an
        // extra box the browser may break a line inside, and the text is not styled.
        return <Fragment key={key}>{node.value}</Fragment>;
      case 'code':
        return (
          <code key={key} className="ab-md__code">
            {node.value}
          </code>
        );
      case 'strong':
        return (
          <strong key={key}>
            <InlineNodes nodes={node.children} externalLinks={externalLinks} />
          </strong>
        );
      case 'emphasis':
        return (
          <em key={key}>
            <InlineNodes nodes={node.children} externalLinks={externalLinks} />
          </em>
        );
      case 'link': {
        const external = isExternal(node.href);
        const newTab = external && externalLinks === 'new-tab';
        return (
          <a
            key={key}
            className="ab-md__link"
            href={node.href}
            // `noopener` severs `window.opener`, without which the opened page can
            // navigate this one — a phishing step that needs no XSS at all.
            {...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            {...(external && !newTab ? { rel: 'noopener noreferrer' } : {})}
          >
            <InlineNodes nodes={node.children} externalLinks={externalLinks} />
            {newTab ? (
              // SC 3.2.5: a link that opens a new window says so before it is followed.
              <span className="ab-visually-hidden"> (opens in a new tab)</span>
            ) : null}
          </a>
        );
      }
      case 'image':
        return (
          <img
            key={key}
            className="ab-md__image"
            src={node.src}
            // An empty alt is the author saying the image carries no information, and is
            // the correct markup for that (WCAG 1.1.1). It is never omitted.
            alt={node.alt}
            loading="lazy"
          />
        );
      case 'break':
        return <br key={key} />;
    }
  });
}

function Blocks({
  blocks,
  headingLevel,
  externalLinks,
}: {
  blocks: readonly Block[];
  headingLevel: 2 | 3 | 4 | 5;
  externalLinks: 'new-tab' | 'same-tab';
}): ReactNode {
  const inline = (nodes: readonly Inline[]): ReactNode => (
    <InlineNodes nodes={nodes} externalLinks={externalLinks} />
  );

  return blocks.map((block, index) => {
    const key = index;
    switch (block.type) {
      case 'heading': {
        // Offset into the surrounding page and clamped at h6, which is where HTML stops.
        const level = Math.min(6, headingLevel + block.level - 1);
        const Tag = `h${String(level)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
        return (
          <Tag key={key} className="ab-md__heading">
            {inline(block.children)}
          </Tag>
        );
      }
      case 'paragraph':
        return (
          <p key={key} className="ab-md__paragraph">
            {inline(block.children)}
          </p>
        );
      case 'code':
        return (
          // SC 2.1.1 again: a code block scrolls horizontally, so the keyboard must be
          // able to reach and scroll it. The same treatment the data table gets.
          <pre
            key={key}
            className="ab-md__pre"
            tabIndex={0}
            role="group"
            aria-label={block.language === null ? 'Code' : `Code, ${block.language}`}
          >
            <code
              className={cx('ab-md__code', block.language !== null && `language-${block.language}`)}
            >
              {block.value}
            </code>
          </pre>
        );
      case 'list': {
        const items = block.items.map((item, itemIndex) => (
          <li key={itemIndex} className="ab-md__item">
            <Blocks blocks={item} headingLevel={headingLevel} externalLinks={externalLinks} />
          </li>
        ));
        return block.ordered ? (
          <ol key={key} className="ab-md__list" start={block.start}>
            {items}
          </ol>
        ) : (
          <ul key={key} className="ab-md__list">
            {items}
          </ul>
        );
      }
      case 'quote':
        return (
          <blockquote key={key} className="ab-md__quote">
            <Blocks
              blocks={block.children}
              headingLevel={headingLevel}
              externalLinks={externalLinks}
            />
          </blockquote>
        );
      case 'rule':
        return <hr key={key} className="ab-md__rule" />;
      case 'table':
        return (
          <div
            key={key}
            className="ab-md__table-scroll"
            tabIndex={0}
            role="group"
            aria-label="Table"
          >
            <table className="ab-md__table">
              <thead>
                <tr>
                  {block.head.map((cell, column) => (
                    <th
                      key={column}
                      scope="col"
                      className={cx('ab-md__cell', alignClass(block.align[column] ?? null))}
                    >
                      {inline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, column) => (
                      <td
                        key={column}
                        className={cx('ab-md__cell', alignClass(block.align[column] ?? null))}
                      >
                        {inline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** Renders author markdown. See the note at the top of this file for why it is safe. */
export function Markdown({
  source,
  headingLevel = 3,
  externalLinks = 'same-tab',
  className,
}: MarkdownProps): ReactNode {
  const document: MarkdownDocument = useMemo(() => parseMarkdown(source), [source]);

  return (
    <div className={cx('ab-md', className)}>
      <Blocks blocks={document.blocks} headingLevel={headingLevel} externalLinks={externalLinks} />
    </div>
  );
}
