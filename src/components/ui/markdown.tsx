import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    p: ({ children }) => <p className="mb-3 whitespace-pre-wrap text-sm leading-6 text-foreground last:mb-0">{children}</p>,
    a: ({ children, href }) => <a href={href} className="text-accent underline underline-offset-2" target="_blank" rel="noreferrer">{children}</a>,
    ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 text-sm leading-6 last:mb-0">{children}</ul>,
    ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm leading-6 last:mb-0">{children}</ol>,
    blockquote: ({ children }) => <blockquote className="mb-3 border-l-2 border-border pl-3 text-sm text-secondary last:mb-0">{children}</blockquote>,
    pre: ({ children }) => <pre className="mb-3 overflow-x-auto border border-border bg-surface-high p-3 text-xs leading-5 text-foreground last:mb-0">{children}</pre>,
    code: ({ className, children }) => <code className={className ? `font-mono ${className}` : "rounded-sm bg-surface-high px-1 py-0.5 font-mono text-[0.85em]"}>{children}</code>
  }}>{content}</ReactMarkdown>;
}
