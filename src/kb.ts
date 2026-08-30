import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import {
  LocationsFile,
  RoutesFile,
  SeasonsFile,
  PermitsFile,
  TenantFile,
  InventoryFile,
  PackagesFile,
  type Location,
  type Route,
  type Season,
  type RestrictedZone,
  type NationalityRule,
  type TenantPolicy,
  type Hotel,
  type Transport,
  type Staff,
  type Extra,
  type Package,
} from "./schemas.js";

const here = dirname(fileURLToPath(import.meta.url));
const KB_ROOT = join(here, "..", "kb");

/**
 * The knowledge base is split into two layers, and the split is the reason the
 * engine is portable across operators:
 *
 *   region/  geography and government rules - where roads go, when passes open,
 *            which zones need permits. Objective, shared by every operator
 *            working the same valleys.
 *
 *   tenant/  commercial terms and policy - which properties this operator has
 *            contracts with, what they pay, how hard they push a drive day.
 *            Different for every operator in the same region.
 *
 * Adding an operator is a new directory under kb/tenants/. Adding a country is
 * a new directory under kb/regions/. Neither is a code change.
 */

export class KbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KbError";
  }
}

function readYaml<T extends z.ZodTypeAny>(path: string, schema: T): z.infer<T> {
  if (!existsSync(path)) {
    throw new KbError(`missing knowledge base file: ${path}`);
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new KbError(`malformed YAML in ${path}: ${(cause as Error).message}`);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new KbError(`invalid knowledge base file ${path}:\n${detail}`);
  }
  return parsed.data;
}

export interface PermitRequirement {
  zone: RestrictedZone;
  /** Nationalities in the group that this zone's permit applies to. */
  appliesToNationalities: string[];
}

export interface KB {
  tenantId: string;
  tenantName: string;
  currency: string;
  policy: TenantPolicy;

  /** True when any loaded file is still carrying placeholder data. */
  hasUnverifiedData: boolean;
  unverifiedFiles: string[];

  location(id: string): Location | null;
  locations(): Location[];
  elevation(locationId: string): number | null;

  route(segmentId: string): Route | null;
  routes(): Route[];
  driveHours(segmentId: string): number | null;

  /** null when the location has no season entry, which loadKb rejects anyway. */
  isOpen(locationId: string, isoDate: string): boolean | null;
  season(locationId: string): Season | null;

  hotel(id: string): Hotel | null;
  hotels(): Hotel[];
  hotelsAt(locationId: string): Hotel[];

  transport(): Transport[];
  staff(): Staff[];
  extras(): Extra[];
  extra(id: string): Extra | null;

  packages(): Package[];

  /** The zone rule for a location, independent of who is travelling. */
  restrictedZone(locationId: string): RestrictedZone | null;
  /** The zone rule narrowed to the travellers it actually applies to. */
  permitFor(locationId: string, nationalities: string[]): PermitRequirement | null;
  nationalityRule(code: string): NationalityRule;
}

/** MM-DD comparison, so a window can be tested without a year. */
function withinWindow(isoDate: string, opens: string, closes: string): boolean {
  const monthDay = isoDate.slice(5); // "YYYY-MM-DD" -> "MM-DD"
  return monthDay >= opens && monthDay <= closes;
}

function isDomestic(nationality: string, country: string): boolean {
  return nationality.toUpperCase() === country.toUpperCase();
}

export function loadKb(tenantId: string, kbRoot: string = KB_ROOT): KB {
  const unverified: string[] = [];
  const noteIfUnverified = (path: string, meta: { verified?: boolean } | undefined) => {
    if (!meta?.verified) unverified.push(path);
  };

  // --- tenant layer -------------------------------------------------------
  const tenantDir = join(kbRoot, "tenants", tenantId);
  const tenant = readYaml(join(tenantDir, "tenant.yaml"), TenantFile);
  const inventory = readYaml(join(tenantDir, "inventory.yaml"), InventoryFile);
  const packagesFile = readYaml(join(tenantDir, "packages.yaml"), PackagesFile);

  if (!inventory.meta?.ratesVerified) {
    unverified.push(join(tenantDir, "inventory.yaml"));
  }

  // --- region layer -------------------------------------------------------
  const locations = new Map<string, Location>();
  const routes = new Map<string, Route>();
  const seasons = new Map<string, Season>();
  const restrictedZones = new Map<string, RestrictedZone>();
  const nationalityRules = new Map<string, NationalityRule>();
  let regionCountry = "PK";

  for (const regionId of tenant.regions) {
    const dir = join(kbRoot, "regions", regionId);

    const locationsFile = readYaml(join(dir, "locations.yaml"), LocationsFile);
    const routesFile = readYaml(join(dir, "routes.yaml"), RoutesFile);
    const seasonsFile = readYaml(join(dir, "seasons.yaml"), SeasonsFile);
    const permitsFile = readYaml(join(dir, "permits.yaml"), PermitsFile);

    noteIfUnverified(join(dir, "locations.yaml"), locationsFile.meta);
    noteIfUnverified(join(dir, "routes.yaml"), routesFile.meta);
    noteIfUnverified(join(dir, "seasons.yaml"), seasonsFile.meta);
    noteIfUnverified(join(dir, "permits.yaml"), permitsFile.meta);

    const country = (locationsFile.meta as { country?: string } | undefined)?.country;
    if (country) regionCountry = country;

    for (const loc of locationsFile.locations) {
      if (locations.has(loc.id)) {
        throw new KbError(`duplicate location id "${loc.id}" (region ${regionId})`);
      }
      locations.set(loc.id, loc);
    }
    for (const route of routesFile.routes) {
      if (routes.has(route.id)) {
        throw new KbError(`duplicate route id "${route.id}" (region ${regionId})`);
      }
      routes.set(route.id, route);
    }
    for (const [id, season] of Object.entries(seasonsFile.seasons)) {
      seasons.set(id, season);
    }
    for (const zone of permitsFile.restrictedZones) {
      restrictedZones.set(zone.id, zone);
    }
    for (const [code, rule] of Object.entries(permitsFile.nationalityRules)) {
      nationalityRules.set(code.toUpperCase(), rule);
    }
  }

  // --- referential integrity ----------------------------------------------
  //
  // Every check below exists because the alternative is a silent default, and
  // a silent default here becomes a wrong quote or an unrunnable trip later.
  const errors: string[] = [];

  for (const loc of locations.values()) {
    if (!seasons.has(loc.id)) {
      errors.push(`location "${loc.id}" has no entry in seasons.yaml`);
    }
  }
  for (const route of routes.values()) {
    const [from, to] = route.id.split(">") as [string, string];
    if (!locations.has(from)) errors.push(`route "${route.id}" starts at unknown location "${from}"`);
    if (!locations.has(to)) errors.push(`route "${route.id}" ends at unknown location "${to}"`);
  }
  for (const zone of restrictedZones.values()) {
    if (!locations.has(zone.id)) {
      errors.push(`restricted zone "${zone.id}" is not a known location`);
    }
  }
  for (const hotel of inventory.hotels) {
    if (!locations.has(hotel.location)) {
      errors.push(`hotel "${hotel.id}" is at unknown location "${hotel.location}"`);
    }
  }
  for (const pkg of packagesFile.packages) {
    for (const locId of pkg.locations) {
      if (!locations.has(locId)) {
        errors.push(`package "${pkg.id}" references unknown location "${locId}"`);
      }
    }
  }
  if (!nationalityRules.has("DEFAULT")) {
    errors.push(`permits.yaml must define a "default" nationality rule`);
  }

  if (errors.length > 0) {
    throw new KbError(
      `knowledge base failed referential integrity for tenant "${tenantId}":\n` +
        errors.map((e) => `  - ${e}`).join("\n"),
    );
  }

  // --- lookups ------------------------------------------------------------
  const hotelsById = new Map(inventory.hotels.map((h) => [h.id, h]));
  const extrasById = new Map(inventory.extras.map((e) => [e.id, e]));

  /**
   * Roads are bidirectional, so routes.yaml stores each segment once and the
   * reverse is resolved here. Without this, an itinerary that returns the way
   * it came raises UNKNOWN_SEGMENT on a road that plainly exists - a false
   * positive that would send the repair loop chasing a non-problem.
   *
   * Drive time is assumed symmetric. If a segment ever needs asymmetric timing,
   * list the reverse explicitly and the exact match below takes precedence.
   */
  const lookupRoute = (id: string): Route | null => {
    const exact = routes.get(id);
    if (exact) return exact;

    const parts = id.split(">");
    if (parts.length !== 2) return null;
    const reversed = routes.get(`${parts[1]}>${parts[0]}`);
    return reversed ? { ...reversed, id } : null;
  };

  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    currency: tenant.currency,
    policy: tenant.policy,

    hasUnverifiedData: unverified.length > 0,
    unverifiedFiles: unverified,

    location: (id) => locations.get(id) ?? null,
    locations: () => [...locations.values()],
    elevation: (id) => locations.get(id)?.elevationM ?? null,

    route: lookupRoute,
    routes: () => [...routes.values()],
    driveHours: (id) => lookupRoute(id)?.driveHours ?? null,

    season: (id) => seasons.get(id) ?? null,
    isOpen: (id, isoDate) => {
      const season = seasons.get(id);
      if (!season) return null;
      return withinWindow(isoDate, season.opens, season.closes);
    },

    hotel: (id) => hotelsById.get(id) ?? null,
    hotels: () => inventory.hotels,
    hotelsAt: (locationId) => inventory.hotels.filter((h) => h.location === locationId),

    transport: () => inventory.transport,
    staff: () => inventory.staff,
    extras: () => inventory.extras,
    extra: (id) => extrasById.get(id) ?? null,

    packages: () => packagesFile.packages,

    nationalityRule: (code) =>
      nationalityRules.get(code.toUpperCase()) ?? nationalityRules.get("DEFAULT")!,

    restrictedZone: (locationId) => {
      const zone = restrictedZones.get(locationId);
      return zone?.requiresPermit ? zone : null;
    },

    permitFor: (locationId, nationalities) => {
      const zone = restrictedZones.get(locationId);
      if (!zone || !zone.requiresPermit) return null;

      const affected = nationalities.filter((nat) => {
        const cls = isDomestic(nat, regionCountry) ? "domestic" : "foreign";
        return zone.appliesTo.includes(cls);
      });
      if (affected.length === 0) return null;

      return { zone, appliesToNationalities: affected };
    },
  };
}
