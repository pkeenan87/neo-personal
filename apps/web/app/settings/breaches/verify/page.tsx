import type { Metadata } from "next";
import { BreachAddressConfirmation } from "@/components/BreachAddressConfirmation";

export const metadata: Metadata = {
  title: "Confirm monitored address",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<{ token?: string | string[] }> };

export default async function ConfirmBreachAddressPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  return (
    <main className="mx-auto min-h-dvh w-full max-w-2xl px-4 py-12">
      <BreachAddressConfirmation token={token} />
    </main>
  );
}
