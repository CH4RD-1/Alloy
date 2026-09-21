import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alloy",
  description: "Project, task and ticket management",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Same type stack as the prototype — display/body/mono — so ported
            views (List, and whatever comes next) keep the same look. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Libre+Franklin:wght@500;600;700;800&family=Public+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        />
      </head>
      {/* Background/text color come from globals.css (`body { background: var(--surface-2); color: var(--text); }`),
          not Tailwind's dark: variant — tailwind.config.ts sets darkMode: "class", but nothing here
          ever toggles a .dark class, so those utilities would never switch with the OS theme. The
          CSS-custom-property tokens already do that switching (via prefers-color-scheme) for every
          ported view, so body needs to follow the same system rather than compete with it. */}
      <body>{children}</body>
    </html>
  );
}
