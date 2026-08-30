import { z } from "zod";

/**
 * Every contract in the pipeline lives here. These schemas drive both the
 * structured-output format sent to the model and the runtime validation of
 * what comes back, so the two can never drift apart.
 */

// ---------------------------------------------------------------------------
// Knowledge base - region layer
// ---------------------------------------------------------------------------

export const KbMeta = z.looseObject({
  verified: z.boolean().default(false),
  source: z.string().optional(),
});

export const Location = z.object({
  id: z.string(),
  name: z.string(),
  /** Sleeping elevation of the settlement, used for acclimatisation checks. */
  elevationM: z.number().int(),
  isGateway: z.boolean().default(false),
  /** Places with no accommodation. Sleeping here is always a violation. */
  isDaytripOnly: z.boolean().default(false),
});

export const RoadQuality = z.enum(["paved", "jeep_track", "foot"]);

export const Route = z.object({
  /** Always "from>to". */
  id: z.string().regex(/^[a-z0-9_]+>[a-z0-9_]+$/, "segment id must be from>to"),
  driveHours: z.number().nonnegative(),
  maxAltitudeM: z.number().int(),
  roadQuality: RoadQuality,
  note: z.string().optional(),
});

const MonthDay = z.string().regex(/^\d{2}-\d{2}$/, "expected MM-DD");

export const Season = z.object({
  opens: MonthDay,
  closes: MonthDay,
  note: z.string().optional(),
});

export const TravellerClass = z.enum(["foreign", "domestic"]);

export const RestrictedZone = z.object({
  id: z.string(),
  name: z.string(),
  requiresPermit: z.boolean(),
  appliesTo: z.array(TravellerClass),
  leadTimeDays: z.number().int().nonnegative(),
});

export const NationalityRule = z.object({
  nocRequired: z.boolean(),
  leadTimeDays: z.number().int().nonnegative(),
  note: z.string().optional(),
});

export const LocationsFile = z.object({
  meta: KbMeta.optional(),
  locations: z.array(Location).min(1),
});

export const RoutesFile = z.object({
  meta: KbMeta.optional(),
  routes: z.array(Route).min(1),
});

export const SeasonsFile = z.object({
  meta: KbMeta.optional(),
  seasons: z.record(z.string(), Season),
});

export const PermitsFile = z.object({
  meta: KbMeta.optional(),
  restrictedZones: z.array(RestrictedZone),
  nationalityRules: z.record(z.string(), NationalityRule),
});

// ---------------------------------------------------------------------------
// Knowledge base - tenant layer
// ---------------------------------------------------------------------------

export const TenantPolicy = z.object({
  maxDriveHoursPerDay: z.number().positive(),
  altitudeRuleAboveM: z.number().int(),
  maxSleepGainPerDayM: z.number().int().positive(),
  marginPct: z.number().min(0).max(1),
  budgetTolerancePct: z.number().min(0).max(1).default(0.1),
});

export const TenantFile = z.object({
  id: z.string(),
  name: z.string(),
  regions: z.array(z.string()).min(1),
  currency: z.string().default("USD"),
  policy: TenantPolicy,
});

export const HotelTier = z.enum(["premium", "standard", "budget", "basic"]);

export const Hotel = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string(),
  tier: HotelTier,
  ratePerRoomUsd: z.number().nonnegative(),
  maxOccupancy: z.number().int().positive(),
});

export const Transport = z.object({
  id: z.string(),
  name: z.string(),
  ratePerDayUsd: z.number().nonnegative(),
  maxPax: z.number().int().positive(),
  requiredFor: z.array(RoadQuality).default([]),
});

export const Staff = z.object({
  id: z.string(),
  name: z.string(),
  ratePerDayUsd: z.number().nonnegative(),
  /** true = one charge for the whole group, false = one per traveller. */
  perGroup: z.boolean(),
});

export const Extra = z.object({
  id: z.string(),
  name: z.string(),
  unitUsd: z.number().nonnegative(),
  per: z.enum(["person", "group"]),
});

export const InventoryFile = z.object({
  meta: z.looseObject({ ratesVerified: z.boolean().default(false) }).optional(),
  hotels: z.array(Hotel),
  transport: z.array(Transport),
  staff: z.array(Staff),
  extras: z.array(Extra).default([]),
});

export const Fitness = z.enum(["low", "moderate", "high"]);

export const Package = z.object({
  id: z.string(),
  title: z.string(),
  nights: z.number().int().positive(),
  locations: z.array(z.string()),
  fitness: Fitness,
  fromUsd: z.number().nonnegative(),
  bestMonths: z.array(z.number().int().min(1).max(12)),
});

export const PackagesFile = z.object({
  meta: z.looseObject({}).optional(),
  packages: z.array(Package).default([]),
});

// ---------------------------------------------------------------------------
// Pipeline contracts
// ---------------------------------------------------------------------------

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const Brief = z.object({
  groupSize: z.number().int().positive(),
  nights: z.number().int().positive(),
  startDate: IsoDate.nullable(),
  endDate: IsoDate.nullable(),
  budgetPpUsd: z.number().nonnegative().nullable(),
  /** ISO 3166-1 alpha-2. Drives permit rules, so absence is never guessed. */
  nationalities: z.array(z.string()),
  interests: z.array(z.string()),
  fitness: Fitness,
  hasChildren: z.boolean(),
  notes: z.string(),
  /** Anything the customer did not state. Drives the clarifying question. */
  missingFields: z.array(z.string()),
});

export const Day = z.object({
  day: z.number().int().positive(),
  /** Must match a location id in the region KB. */
  location: z.string(),
  activity: z.string(),
  /** Must exist in the tenant inventory. null on the departure day. */
  hotelId: z.string().nullable(),
  /** Segment ids travelled on this day, e.g. ["skardu>khaplu"]. */
  driveSegments: z.array(z.string()),
  isRestDay: z.boolean(),
});

export const DraftItinerary = z.object({
  title: z.string(),
  days: z.array(Day).min(1),
  /** What the model inferred rather than was told. Shown to the operator. */
  assumptions: z.array(z.string()),
});

/**
 * Violation codes.
 *
 * UNKNOWN_SEGMENT and UNVERIFIABLE_DATES are additions to the original spec
 * list. An invented road and an unverifiable itinerary are distinct failures
 * from an invented place, and collapsing them produces repair prompts that
 * describe the wrong problem.
 */
export const ViolationCode = z.enum([
  "CLOSED",
  "DRIVE_HOURS",
  "ALTITUDE_GAIN",
  "NO_INVENTORY",
  "PERMIT_MISSING",
  "BUDGET_EXCEEDED",
  "NIGHTS_MISMATCH",
  "UNKNOWN_LOCATION",
  "UNKNOWN_SEGMENT",
  "UNVERIFIABLE_DATES",
]);

export const Violation = z.object({
  code: ViolationCode,
  /** 0 when the violation is about the itinerary as a whole. */
  day: z.number().int().nonnegative(),
  detail: z.string(),
  severity: z.enum(["hard", "soft"]),
});

export const CostLine = z.object({
  label: z.string(),
  category: z.enum(["accommodation", "transport", "staff", "extras"]),
  unitUsd: z.number(),
  qty: z.number(),
  amountUsd: z.number(),
});

export const CostSheet = z.object({
  lines: z.array(CostLine),
  subtotalUsd: z.number(),
  marginPct: z.number(),
  totalUsd: z.number(),
  perPersonUsd: z.number(),
});

export type Location = z.infer<typeof Location>;
export type Route = z.infer<typeof Route>;
export type Season = z.infer<typeof Season>;
export type TravellerClass = z.infer<typeof TravellerClass>;
export type RestrictedZone = z.infer<typeof RestrictedZone>;
export type NationalityRule = z.infer<typeof NationalityRule>;
export type TenantPolicy = z.infer<typeof TenantPolicy>;
export type Hotel = z.infer<typeof Hotel>;
export type Transport = z.infer<typeof Transport>;
export type Staff = z.infer<typeof Staff>;
export type Extra = z.infer<typeof Extra>;
export type Package = z.infer<typeof Package>;
export type Brief = z.infer<typeof Brief>;
export type Day = z.infer<typeof Day>;
export type DraftItinerary = z.infer<typeof DraftItinerary>;
export type ViolationCode = z.infer<typeof ViolationCode>;
export type Violation = z.infer<typeof Violation>;
export type CostLine = z.infer<typeof CostLine>;
export type CostSheet = z.infer<typeof CostSheet>;
export type RoadQuality = z.infer<typeof RoadQuality>;
export type Fitness = z.infer<typeof Fitness>;
