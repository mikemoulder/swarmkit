import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./style.css";

export const metadata: Metadata = {
  title: "SwarmKit | Market simulator",
  description: "Run a sealed-bid procurement market with SwarmKit.",
  other: { "page-type": "software", "site-kind": "software" },
};

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en" data-type="software"><body>{children}</body></html>;
}
