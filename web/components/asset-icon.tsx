import type { ReactNode } from "react";
import type { AssetIconKey } from "@/lib/assets-view";

// SVG paths copied verbatim from the prototype's ASSET_ICONS map (see the
// "Live prototype" link in alloy-development-log.md) — a fixed preset
// gallery of generic line icons for physical assets (laptops, tools, PPE)
// rather than photos, so every asset card stays visually consistent.
export function AssetIcon({ icon }: { icon: string }) {
  const key = (icon as AssetIconKey) in PATHS ? (icon as AssetIconKey) : "other";
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {PATHS[key]}
    </svg>
  );
}

const PATHS: Record<AssetIconKey, ReactNode> = {
  laptop: (
    <>
      <rect x="4" y="4" width="16" height="11" rx="1" />
      <path d="M2 19h20l-1.5-3h-17z" />
    </>
  ),
  desktop: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  monitor: (
    <>
      <rect x="2" y="4" width="20" height="13" rx="1" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  phone: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12" />
    </>
  ),
  mouse: (
    <>
      <rect x="7" y="2" width="10" height="20" rx="5" />
      <path d="M12 2v7" />
    </>
  ),
  toolbox: (
    <>
      <rect x="2" y="9" width="20" height="12" rx="2" />
      <path d="M8 9V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3" />
      <path d="M2 14h20" />
      <path d="M10 14v2h4v-2" />
    </>
  ),
  hardhat: (
    <>
      <path d="M4 15a8 8 0 0 1 16 0z" />
      <path d="M2 15h20" />
      <path d="M12 7V4" />
    </>
  ),
  boots: (
    <>
      <path d="M8 2v10.5c0 1-.5 1.8-1.3 2.5L3 18.5c-.6.5-1 1.3-1 2.1V21h9v-4l1.5-1" />
      <path d="M8 2h5v13" />
      <path d="M13 15h4.5c1.9 0 3.5 1.6 3.5 3.5V21H13z" />
    </>
  ),
  trousers: (
    <>
      <path d="M6 2h12l1 8-2 12h-3l-1.5-11L11 22H8L6 10z" />
      <path d="M6.5 8h11" />
    </>
  ),
  other: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
};
