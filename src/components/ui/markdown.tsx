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
    code: ({ className, children }) => <code className={className ? `font-mono ${className}` : "rounded-sm bg-surface-high px-1 py-0.5 font-mono text-[0.85em]"}>{children}</code>,
    table: ({ children }) => <div role="region" aria-label="Scrollable table" tabIndex={0} className="mb-3 max-w-full overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20 last:mb-0"><table className="w-full min-w-max border-collapse text-left">{children}</table></div>,
    th: ({ children }) => <th className="min-w-32 whitespace-nowrap border border-border bg-surface-high px-3 py-2 text-xs font-medium text-foreground">{children}</th>,
    td: ({ children }) => <td className="min-w-32 border border-border px-3 py-2 align-top text-sm leading-6 text-foreground">{children}</td>
  }}>{content}</ReactMarkdown>;
}
