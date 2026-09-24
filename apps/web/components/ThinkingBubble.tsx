// Lifted from Neo web/components/ThinkingBubble.
export function ThinkingBubble({ className }: { className?: string }) {
  return (
    <div
      className={`inline-flex items-center gap-1 rounded-2xl bg-surface-2 px-3 py-2.5 ${className ?? ""}`}
      aria-hidden="true"
      data-testid="thinking-bubble"
    >
      <span className="animate-neo-bounce size-1.5 rounded-full bg-muted" />
      <span className="animate-neo-bounce size-1.5 rounded-full bg-muted [animation-delay:150ms]" />
      <span className="animate-neo-bounce size-1.5 rounded-full bg-muted [animation-delay:300ms]" />
    </div>
  );
}
