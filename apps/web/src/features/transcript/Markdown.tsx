// Transcript markdown: react-markdown + GFM through rehype-sanitize, styled
// entirely with tokens. Fenced code renders in a bordered mono card with a
// copy affordance; links open in the default browser with rel="noreferrer"
// under the sanitize schema.
import { cn, IconButton, Tooltip, TooltipPopup, TooltipTrigger } from "@t4-code/ui";
import { Check, Copy } from "lucide-react";
import { memo, type ReactNode, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

function extractText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node !== null && typeof node === "object" && "props" in node) {
    const props = node.props;
    if (props !== null && typeof props === "object" && "children" in props) {
      return extractText(props.children);
    }
  }
  return "";
}

export function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <IconButton
            aria-label={label}
            className="size-11 sm:size-6"
            onClick={() => {
              void navigator.clipboard.writeText(text);
              setCopied(true);
              if (resetRef.current !== null) clearTimeout(resetRef.current);
              resetRef.current = setTimeout(() => setCopied(false), 1500);
            }}
            size="icon-xs"
          >
            {copied ? <Check aria-hidden="true" className="text-success-foreground" /> : <Copy aria-hidden="true" />}
          </IconButton>
        }
      />
      <TooltipPopup side="top">{copied ? "Copied" : label}</TooltipPopup>
    </Tooltip>
  );
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const language = /language-(\w+)/.exec(className ?? "")?.[1] ?? "";
  const text = extractText(children).replace(/\n$/, "");
  return (
    <div className="group/code my-2 overflow-hidden rounded-lg border border-border bg-(--markdown-codeblock-background)">
      <div className="flex h-11 items-center justify-between border-border/60 border-b pr-1 pl-3 sm:h-7">
        <span className="font-mono text-[0.6875rem] text-muted-foreground">{language || "code"}</span>
        <span className="opacity-100 transition-opacity duration-(--motion-duration-fast) sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/code:opacity-100">
          <CopyButton label="Copy code" text={text} />
        </span>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 space-y-2 break-words text-sm leading-normal [text-wrap:pretty]",
        className,
      )}
    >
      <ReactMarkdown
        components={{
          a: ({ children, href }) => (
            <a
              className="text-(--markdown-link) underline decoration-(--markdown-link)/40 underline-offset-2 transition-colors duration-(--motion-duration-fast) hover:decoration-(--markdown-link)"
              href={href}
              rel="noreferrer"
              target="_blank"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-border border-l-1 pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          code: ({ children, className: codeClassName }) => {
            // Block code is wrapped by `pre` below; this handles inline only.
            if (codeClassName?.includes("language-") === true) {
              return <code className={codeClassName}>{children}</code>;
            }
            return (
              <code className="rounded-sm border border-border bg-(--markdown-code-background) px-1 py-px font-mono text-xs">
                {children}
              </code>
            );
          },
          h1: ({ children }) => (
            <h1 className="pt-1 font-heading font-semibold text-foreground text-xl [text-wrap:balance]">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="pt-1 font-heading font-semibold text-foreground text-lg [text-wrap:balance]">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="pt-1 font-semibold text-base text-foreground [text-wrap:balance]">
              {children}
            </h3>
          ),
          h4: ({ children }) => <h4 className="font-semibold text-foreground text-sm">{children}</h4>,
          h5: ({ children }) => <h5 className="font-semibold text-foreground text-sm">{children}</h5>,
          h6: ({ children }) => <h6 className="font-semibold text-foreground text-sm">{children}</h6>,
          hr: () => <hr className="my-3 border-(--markdown-rule)" />,
          li: ({ children }) => <li className="[&>p]:inline">{children}</li>,
          ol: ({ children }) => (
            <ol className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>
          ),
          pre: ({ children }) => {
            // Reach into the single code child for language + text.
            if (
              children !== null &&
              typeof children === "object" &&
              "props" in children &&
              children.props !== null &&
              typeof children.props === "object"
            ) {
              // Guarded above: non-null object props from a React element.
              const props = children.props as Record<string, unknown>;
              const codeClassName = typeof props.className === "string" ? props.className : "";
              return (
                <CodeBlock className={codeClassName}>
                  {props.children as ReactNode /* child of a rendered <pre>: always a ReactNode */}
                </CodeBlock>
              );
            }
            return <CodeBlock>{children}</CodeBlock>;
          },
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          td: ({ children }) => (
            <td className="border-border border-b px-2 py-1 align-top">{children}</td>
          ),
          th: ({ children }) => (
            <th className="border-border border-b px-2 py-1 text-left font-semibold">{children}</th>
          ),
          ul: ({ children }) => (
            <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>
          ),
        }}
        rehypePlugins={[rehypeSanitize]}
        remarkPlugins={[remarkGfm, remarkBreaks]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
