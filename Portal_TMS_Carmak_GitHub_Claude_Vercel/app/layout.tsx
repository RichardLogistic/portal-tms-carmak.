import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Portal TMS Corporativo Carmak",
  description:
    "Central corporativa de inteligência logística, rastreamento, fiscal, financeiro e governança da Carmak.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
