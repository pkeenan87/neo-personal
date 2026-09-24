/** Neo logo mark: a rounded shield. Decorative by default. */
export function NeoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <path
        d="M12 2.25 4.5 5.1v6.15c0 4.64 3.2 8.97 7.5 10.5 4.3-1.53 7.5-5.86 7.5-10.5V5.1L12 2.25Z"
        fill="currentColor"
      />
      <path
        d="m8.6 12.2 2.3 2.3 4.6-4.9"
        fill="none"
        stroke="var(--accent-fg, #fff)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
