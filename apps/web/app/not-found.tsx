import Link from "next/link";
import { NeoMark } from "@/components/NeoMark";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <NeoMark className="size-10 text-accent" />
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-muted">That conversation doesn&apos;t exist or you don&apos;t have access to it.</p>
      <Link href="/chat" className="mt-2 font-medium text-accent hover:text-accent-hover">
        Start a new check
      </Link>
    </main>
  );
}
