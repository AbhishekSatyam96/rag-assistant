import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { ThemeProvider, THEME_SCRIPT } from "@/lib/theme";
import { AppShell } from "@/components/AppShell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "RAG Knowledge Assistant",
    // Every page sets its own short title and gets the product name appended,
    // so a pinned tab reads "Ask · RAG Knowledge Assistant" instead of six
    // identical favicons.
    template: "%s · RAG Knowledge Assistant",
  },
  description: "Upload documents, ask questions, get grounded answers with citations.",
};

export const viewport: Viewport = {
  // Matches the theme tokens, so mobile Safari's chrome and the Android status
  // bar tint with the app instead of framing it in white. Two entries rather
  // than one, because this element pre-dates the theme attribute and only
  // understands the media query.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfc" },
    { media: "(prefers-color-scheme: dark)", color: "#131419" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning is required and narrowly scoped: the inline
    // script below writes data-theme onto this exact element before React
    // hydrates, so the server's HTML and the client's DOM legitimately differ
    // here. It suppresses the warning for this element's attributes only — not
    // for its subtree — so a real mismatch anywhere else still surfaces.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
    >
      <head>
        {/* Blocking, in <head>, before any paint. See THEME_SCRIPT for why it
            can't be an effect. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">
        {/* ThemeProvider outside AuthProvider: the header's theme picker has to
            work on public pages too, and the theme has no dependency on who
            you are. AppShell needs both, so it sits innermost. */}
        <ThemeProvider>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
