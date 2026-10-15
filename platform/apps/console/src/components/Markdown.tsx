import { Table, TableHead, TableCell } from "@/components/ui/table";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createLowlight } from "lowlight";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import plaintext from "highlight.js/lib/languages/plaintext";

/**
 * Hand-rolled syntax highlighting registry. Replaces rehype-highlight,
 * which pulls all 36+ languages from lowlight's `common` set (>500 KB
 * gzipped). The console only renders bash/json/yaml/python/ts/js in
 * chat output — registering only those keeps the bundle lean.
 *
 * To add a language: import from `highlight.js/lib/languages/<name>`
 * and add it (plus any aliases) to the createLowlight() call.
 */
const lowlight = createLowlight({
  bash,
  sh: bash,
  shell: bash,
  zsh: bash,
  json,
  yaml,
  yml: yaml,
  python,
  py: python,
  typescript,
  ts: typescript,
  javascript,
  js: javascript,
  jsx: javascript,
  tsx: typescript,
  plaintext,
  text: plaintext,
});

const jsxRuntime = { Fragment, jsx, jsxs } as Parameters<typeof toJsxRuntime>[1];

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded-xl border border-ddc-border bg-ddc-surface-muted p-3 text-sm">
            {children}
          </pre>
        ),
        // `node` это служебный проп react-markdown (AST-узел). В DOM он попадал
        // как node="[object Object]", поэтому отделяем его от остальных props.
        code: ({ className, children, node: _node, ...props }) => {
          const isInline = !className;
          if (isInline) {
            return (
              <code className="rounded-md bg-ddc-surface-sunken px-1 py-0.5 font-mono text-xs" {...props}>
                {children}
              </code>
            );
          }
          // Block code with a language hint — apply syntax highlighting if
          // the language is in our registered set, otherwise render plain.
          const langMatch = /language-([\w-]+)/.exec(className || "");
          const lang = langMatch?.[1];
          const codeText = typeof children === "string"
            ? children
            : Array.isArray(children) ? children.join("") : String(children ?? "");
          if (lang && lowlight.registered(lang)) {
            const tree = lowlight.highlight(lang, codeText.replace(/\n$/, ""));
            return (
              <code className={`${className} font-mono hljs`} {...props}>
                {toJsxRuntime(tree, jsxRuntime)}
              </code>
            );
          }
          return (
            <code className={`${className} font-mono`} {...props}>
              {children}
            </code>
          );
        },
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-5 my-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 my-1">{children}</ol>,
        li: ({ children }) => <li className="my-0.5">{children}</li>,
        h1: ({ children }) => <h1 className="font-display mt-3 mb-1 text-lg font-semibold text-ddc-heading">{children}</h1>,
        h2: ({ children }) => <h2 className="font-display mt-2 mb-1 text-base font-semibold text-ddc-heading">{children}</h2>,
        h3: ({ children }) => <h3 className="mt-2 mb-1 font-semibold text-ddc-heading">{children}</h3>,
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-ddc-border-strong pl-3 text-ddc-label">{children}</blockquote>
        ),
        table: ({ children }) => (
          <Table className="border-collapse my-2 text-sm w-full">{children}</Table>
        ),
        th: ({ children }) => (
          <TableHead className="border border-ddc-divider bg-ddc-surface-muted px-3 py-2 text-left text-sm font-semibold tracking-normal text-ddc-heading normal-case">{children}</TableHead>
        ),
        td: ({ children }) => (
          <TableCell className="border border-ddc-divider px-3 py-2 text-ddc-text">{children}</TableCell>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
