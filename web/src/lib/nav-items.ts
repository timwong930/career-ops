import { LayoutDashboard, Compass, ListChecks, Send, Radar, BarChart3, FileText, Settings } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

// Single source of truth for the app's primary destinations — shared by the
// desktop sidebar and the mobile nav so they can never drift.
export type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  chip?: string;
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/explore", label: "Discover", icon: Compass, chip: "New" },
  { href: "/pipeline", label: "Applications", icon: ListChecks },
  { href: "/followups", label: "Follow-ups", icon: Send },
  { href: "/portals", label: "Job Sources", icon: Radar },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/cv", label: "Resume", icon: FileText },
  { href: "/config", label: "Settings", icon: Settings },
];

export function isActivePath(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
