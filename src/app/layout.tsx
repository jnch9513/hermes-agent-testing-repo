import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_HK } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Chinese glyphs fall back to Noto Sans HK (Vercel-style clean sans for CJK)
const notoHK = Noto_Sans_HK({
  variable: "--font-noto-hk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "遊戲大廳",
  description: "朋友圍實時遊戲大廳 — 緊上線名單 + 房間",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-HK"
      className={`${geistSans.variable} ${geistMono.variable} ${notoHK.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          // Apply saved theme before paint to avoid flash
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('hw_theme');if(!t)t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';if(t==='dark')document.documentElement.classList.add('dark');document.documentElement.style.colorScheme=t;}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
