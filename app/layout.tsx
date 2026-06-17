import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NCM 转换器",
  description: "Convert NetEase Cloud Music ncm files on macOS.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
