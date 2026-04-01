import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CourtVision Pro',
  description: '3D Basketball Play Designer',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-court text-white antialiased">{children}</body>
    </html>
  );
}