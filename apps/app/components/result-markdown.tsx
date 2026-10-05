"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useState, type ReactNode } from "react";

/**
 * Rendering what a provider actually returned.
 *
 * The result is the product. A buyer just paid a stranger's machine to write
 * code, and dumping the raw response into a `<pre>` — fences, backticks and
 * all — makes the thing they bought look like a log line. Agent CLIs answer in
 * markdown, so render it as markdown.
 *
 * ## The palette problem
 *
 * The brand runs black, white, hairline grey, and exactly one accent that only
 * ever means "live". A stock syntax theme brings six saturated colours and
 * blows that apart — the result panel would become the loudest thing in the
 * app. So highlighting here is **tonal**: one hue family for anything the
 * language treats as special, and weight plus brightness carrying the rest.
 * Code still reads as structured; the page still reads as Xorv.
 *
 * Overrides are per-element rather than a global stylesheet, because the
 * surrounding UI already owns `p`, `a`, `pre` and friends, and a markdown
 * reset that leaks would quietly restyle the rest of the page.
 */

/** A copy button, because the whole point of buying code is taking it away. */
function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
      aria-label="Copy code"
      className="absolute right-2 top-2 rounded-md border border-[var(--line)] bg-black/70 px-2 py-1 text-[11px] text-fg-3 opacity-0 transition-all group-hover:opacity-100 hover:border-[var(--line-2)] hover:text-fg focus-visible:opacity-100"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

export function ResultMarkdown({ children }: { children: string }) {
  return (
    <div className="result-md max-h-[34rem] overflow-auto text-[13.5px] leading-relaxed text-fg-2">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          h1: ({ children }) => (
            <h3 className="mt-5 text-[15px] font-medium text-fg first:mt-0">{children}</h3>
          ),
          h2: ({ children }) => (
            <h4 className="mt-5 text-[14px] font-medium text-fg first:mt-0">{children}</h4>
          ),
          h3: ({ children }) => (
            <h5 className="mt-4 text-[13.5px] font-medium text-fg first:mt-0">{children}</h5>
          ),
          p: ({ children }) => <p className="mt-3 first:mt-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="mt-3 list-disc space-y-1 pl-5 marker:text-fg-4">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mt-3 list-decimal space-y-1 pl-5 marker:text-fg-4">{children}</ol>
          ),
          strong: ({ children }) => <strong className="font-medium text-fg">{children}</strong>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-fg underline underline-offset-2 transition-colors hover:text-[var(--live)]"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mt-3 border-l-2 border-[var(--line-2)] pl-3 text-fg-3">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-5 border-[var(--line)]" />,
          table: ({ children }) => (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-[var(--line-2)] px-2 py-1.5 text-left font-medium text-fg">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">{children}</td>
          ),
          // Inline code stays inline; only fenced blocks get the surface.
          code: ({ className, children, ...rest }) => {
            const fenced = /language-/.test(className ?? "");
            if (!fenced) {
              return (
                <code className="mono rounded border border-[var(--line)] bg-[var(--surface-2)] px-1 py-0.5 text-[12px] text-fg">
                  {children}
                </code>
              );
            }
            return (
              <code className={`${className ?? ""} mono block text-[12.5px] leading-relaxed`} {...rest}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => {
            const source = textOf(children);
            const lang = /language-([\w-]+)/.exec(
              (children as { props?: { className?: string } })?.props?.className ?? "",
            )?.[1];
            return (
              <div className="group relative mt-3 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--surface)]">
                {lang ? (
                  <div className="border-b border-[var(--line)] px-3 py-1.5 text-[10.5px] uppercase tracking-[0.14em] text-fg-4">
                    {lang}
                  </div>
                ) : null}
                <Copy text={source} />
                <pre className="overflow-x-auto p-3.5">{children}</pre>
              </div>
            );
          },
        }}
      >
        {children}
      </Markdown>

      {/* Tonal highlighting. One hue family plus weight — the brand's single
          accent is reserved for live state and is deliberately not used here. */}
      <style jsx global>{`
        .result-md .hljs-keyword,
        .result-md .hljs-built_in,
        .result-md .hljs-literal {
          color: #d7d7d7;
          font-weight: 500;
        }
        .result-md .hljs-string,
        .result-md .hljs-regexp {
          color: #9ec7a8;
        }
        .result-md .hljs-title,
        .result-md .hljs-title.function_,
        .result-md .hljs-section {
          color: #fafafa;
        }
        .result-md .hljs-type,
        .result-md .hljs-class .hljs-title {
          color: #b9c6d4;
        }
        .result-md .hljs-number,
        .result-md .hljs-symbol {
          color: #c9bda4;
        }
        .result-md .hljs-comment,
        .result-md .hljs-quote {
          color: #6e6e6e;
          font-style: italic;
        }
        .result-md .hljs-attr,
        .result-md .hljs-property,
        .result-md .hljs-variable {
          color: #c2c2c2;
        }
        .result-md .hljs-params {
          color: #a1a1a1;
        }
        .result-md .hljs-deletion {
          color: #f87171;
        }
        .result-md .hljs-addition {
          color: #4ade80;
        }
      `}</style>
    </div>
  );
}
