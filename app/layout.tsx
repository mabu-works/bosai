/* bosai — root layout: header navigation, footer credits, PWA wiring. */

import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import SwRegister from "@/components/SwRegister";

export const metadata: Metadata = {
  title: { default: "bosai", template: "%s | bosai" },
  description: "地震・津波・緊急地震速報・気象警報・台風・天気をまとめて表示する防災情報サイト",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#0b1220",
};

const NAV = [
  { href: "/", label: "トップ" },
  { href: "/quakes", label: "地震一覧" },
  { href: "/stations", label: "震度観測点" },
  { href: "/amedas", label: "AMeDAS" },
  { href: "/tsunami-stations", label: "津波観測点" },
  { href: "/volcanoes", label: "火山" },
  { href: "/rivers", label: "河川" },
  { href: "/stats", label: "統計" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <header className="site-header">
          <Link href="/" className="site-title">
            bosai
          </Link>
          <nav className="site-nav">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}>
                {n.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="site-main">{children}</main>
        <footer className="site-footer">
          <p>出典: 気象庁・P2P地震情報｜A.A.S 編集電文</p>
          <p>地図: 国土地理院 / 天気予報: Open-Meteo</p>
        </footer>
        <SwRegister />
      </body>
    </html>
  );
}
