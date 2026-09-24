import type { Metadata, Viewport } from "next";
import { Toaster } from "@/components/Toaster";
import { ToastProvider } from "@/components/toast-context";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Neo — your personal security assistant", template: "%s · Neo" },
  description:
    "Neo checks suspicious links, emails, and text messages and tells you in plain language whether they're safe and what to do next.",
  applicationName: "Neo",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1120" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-bg text-fg">
        <ToastProvider>
          {children}
          <Toaster />
        </ToastProvider>
      </body>
    </html>
  );
}
