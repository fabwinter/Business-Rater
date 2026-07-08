// NOTE: the storage shim is intentionally NOT imported here. This file is
// a Server Component (no "use client") — window doesn't exist when it
// renders, so importing lib/storage here wouldn't reliably attach it
// before the client component that needs it mounts. Import it at the top
// of components/RankConsole.jsx instead (which already has "use client"
// and is where window.storage.get/set actually get called from).

export const metadata = {
  title: "Rank Console",
  description: "Local SEO & online-business growth command center",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
