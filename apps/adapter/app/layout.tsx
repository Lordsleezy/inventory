import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Floor",
  description: "Liquidation store operating system",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
