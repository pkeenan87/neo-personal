import Image from "next/image";

/** The Neo shield. Decorative unless a title is provided. */
export function NeoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <Image
      src="/neo-shield.png"
      width={1280}
      height={1280}
      alt={title ?? ""}
      className={className}
    />
  );
}
