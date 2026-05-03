// Seat assignment model. Every hired agent gets a stable workstation in the
// 3D office; this file defines the zones, the desk pools per zone, and the
// algorithm that picks a free seat at hire time.
//
// Workstation IDs (e.g. "cubicle-pit-1") are physical 3D anchors defined in
// `apps/web/src/features/theater/office-anchors.ts`. They're treated as
// opaque strings here; the server doesn't know the 3D position, only the
// zone grouping.

import type { RoleCategory, RoleDefinition } from "./role-catalog";
import { CEO_ROLE, getRoleDefinition } from "./role-catalog";
import type { AgentRole } from "./types";

// Seating zone identifiers. Shaped as `as const` so the union type below
// auto-derives from the array — adding a zone is a one-line change.
export const SEATING_ZONES = [
  "exec",
  "engineering",
  "product_design",
  "marketing_growth",
  "editorial_content",
  "operations_admin",
  "data_research",
  "web3",
  "reserved_meeting",
  "reserved_lobby",
] as const;
export type SeatingZone = (typeof SEATING_ZONES)[number];

// Desk pools per zone. The first slot of `exec` IS the CEO's dedicated
// private office (`CEO_DESK` below). New workstations added in
// office-anchors.ts must be either listed here (assignable) or left out
// (unassignable / decorative).
export const ZONE_DESKS: Record<SeatingZone, readonly string[]> = {
  exec: ["home-office-1", "lounge-1", "lounge-2", "lounge-3"],
  engineering: [
    "cubicle-pit-1",
    "cubicle-pit-2",
    "cubicle-pit-3",
    "cubicle-pit-4",
    "cubicle-back-1",
    "cubicle-back-2",
    "cubicle-back-3",
  ],
  web3: [
    "cubicle-back-4",
    "cubicle-back-5",
    "cubicle-back-6",
    "cubicle-back-7",
    "cubicle-back-8",
    "cubicle-back-9",
  ],
  data_research: [
    "open-desks-1",
    "open-desks-2",
    "open-desks-3",
    "open-desks-4",
    "center-bay-1",
    "center-bay-2",
  ],
  product_design: ["side-bay-1", "side-bay-2", "side-bay-3"],
  editorial_content: ["far-right-1", "far-right-2"],
  marketing_growth: ["far-right-3", "far-right-4", "far-right-5"],
  operations_admin: ["entry-row-1", "entry-row-2", "entry-row-3", "basement-1"],
  reserved_meeting: [
    "meeting-desk-1",
    "meeting-desk-2",
    "boardroom-1",
    "boardroom-2",
    "boardroom-3",
    "boardroom-4",
    "boardroom-5",
    "boardroom-6",
    "boardroom-7",
  ],
  reserved_lobby: ["lobby-1", "lobby-2"],
};

// CEO's dedicated private office. Derived as the first slot of the exec
// zone so the literal lives in exactly one place (ZONE_DESKS).
export const CEO_DESK: string = ZONE_DESKS.exec[0];

// Zones that the overflow scan must NOT use. Meeting rooms host transient
// meetings (not assigned seats); lobby is reception. Exec is reserved so
// non-C-suite agents don't squat on the CEO desk or in the C-suite lounge
// when their own zone fills.
const RESERVED_OVERFLOW_ZONES: ReadonlySet<SeatingZone> = new Set([
  "exec",
  "reserved_meeting",
  "reserved_lobby",
]);

// Default routing: role.category → seating zone. Roles without an explicit
// `seatingZoneOverride` follow this map. Categories that don't have a
// dedicated zone (sales_success, leadership) resolve to a fallback zone.
const CATEGORY_TO_ZONE: Record<RoleCategory, SeatingZone> = {
  c_suite: "exec",
  leadership: "operations_admin", // safety net — heads should set override
  engineering: "engineering",
  product_design: "product_design",
  marketing_growth: "marketing_growth",
  editorial_content: "editorial_content",
  operations_admin: "operations_admin",
  sales_success: "marketing_growth", // no dedicated sales floor — sit with marketing
  data_research: "data_research",
  web3: "web3",
};

// Order to scan when the agent's primary zone is full. Skips reserved zones.
const OVERFLOW_ZONE_ORDER: readonly SeatingZone[] = [
  "engineering",
  "data_research",
  "operations_admin",
  "marketing_growth",
  "editorial_content",
  "product_design",
  "web3",
];

// Default zone routed when the role is unknown / not in the catalog. Single
// reference so changing the fallback target is a one-line edit.
const FALLBACK_ZONE: SeatingZone = "operations_admin";

export function zoneForRole(role: AgentRole): SeatingZone {
  const def = getRoleDefinition(role);
  if (!def) return FALLBACK_ZONE; // unknown custom role → ops fallback
  return def.seatingZoneOverride ?? CATEGORY_TO_ZONE[def.category];
}

// Result of the seat assignment attempt. `null` → office literally full.
export function assignSeat(args: {
  role: AgentRole;
  occupied: ReadonlySet<string>;
}): string | null {
  const def = getRoleDefinition(args.role);
  const isCEO = args.role === CEO_ROLE;

  // CEO always gets the dedicated home-office seat when free.
  if (isCEO && !args.occupied.has(CEO_DESK)) return CEO_DESK;

  const primaryZone = def
    ? (def.seatingZoneOverride ?? CATEGORY_TO_ZONE[def.category])
    : FALLBACK_ZONE;

  // First pass: agent's own zone (skip CEO desk for non-CEOs).
  const primarySeat = pickFreeSeat(primaryZone, args.occupied, isCEO);
  if (primarySeat) return primarySeat;

  // Overflow: scan other non-reserved zones in fixed order.
  for (const zone of OVERFLOW_ZONE_ORDER) {
    if (zone === primaryZone) continue;
    if (RESERVED_OVERFLOW_ZONES.has(zone)) continue;
    const seat = pickFreeSeat(zone, args.occupied, isCEO);
    if (seat) return seat;
  }

  return null;
}

function pickFreeSeat(
  zone: SeatingZone,
  occupied: ReadonlySet<string>,
  isCEO: boolean,
): string | null {
  const desks = ZONE_DESKS[zone];
  for (const d of desks) {
    if (occupied.has(d)) continue;
    if (!isCEO && d === CEO_DESK) continue; // CEO desk only for CEO
    return d;
  }
  return null;
}

// All assignable desks across every zone (including reserved). Helpers in
// the seating service use this to validate whether a stored
// `agents.workstation_id` still maps to a real anchor. Manual flatten —
// `Array.prototype.flat` is ES2019 and this package targets ES2017.
function buildAllDesks(): ReadonlySet<string> {
  const set = new Set<string>();
  for (const desks of Object.values(ZONE_DESKS)) {
    for (const id of desks) set.add(id);
  }
  return set;
}
export const ALL_DESKS: ReadonlySet<string> = buildAllDesks();

// Derived set of every role's home zone — used by tests / debug tools to
// ensure no role routes to an undefined zone.
export function isReservedZone(zone: SeatingZone): boolean {
  return RESERVED_OVERFLOW_ZONES.has(zone);
}

// Re-exported for consumers that want to render the catalog grouped by zone.
export type { RoleDefinition };
