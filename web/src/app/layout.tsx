import type { Metadata } from "next";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quoin Property Intelligence",
  description: "Source-linked property intelligence from Quoin Data.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><AuthKitProvider>{children}</AuthKitProvider></body></html>;
}
