import type { Metadata, Viewport } from "next";
import { Toaster } from "@/components/Toaster";
import { ToastProvider } from "@/components/toast-context";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEME_COLORS, THEME_INIT_SCRIPT } from "@/lib/theme";
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
  themeColor: THEME_COLORS.light,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-bg text-fg">
        <ThemeProvider>
          <ToastProvider>
            {children}
            <Toaster />
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
