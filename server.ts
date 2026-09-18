import { createServer } from "node:http";
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JsonValue } from "@typesafe-ai/sdk";
import { bearing, compassWord, destination, distanceKm } from "./geo.ts";

const PORT = Number(process.env.PORT ?? 8787);
const TICK_MS = Number(process.env.TICK_MS ?? 15000);
const JOURNAL = process.env.JOURNAL ?? "journey.jsonl";
const CONTACT = process.env.CONTACT ?? "https://github.com/local/wanderer";
const USER_AGENT = `wanderer/1.0 (+${CONTACT})`;
const OVERPASS = (
  process.env.OVERPASS_URL ??
  "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter"
).split(",");

// Which highway classes the walker may use, and therefore what counts as a fork
// worth stopping for. The default is "real forks": the classified network that
// links villages, so bends and side streets do not interrupt the walk. Append
// |residential|living_street|service|track to stop at every junction instead —
// faithful to "turns wherever there is more than one road", but in a town that
// is a decision every thirty metres and the walk never leaves it.
const ROADS =
  process.env.ROADS ?? "motorway|trunk|primary|secondary|tertiary|unclassified|road";

const STEP_KM = Number(process.env.STEP_KM ?? 2.5);
const SPOKE_MAX_KM = Number(process.env.SPOKE_MAX_KM ?? 0.45);
const NETWORK_RADIUS_M = Number(process.env.NETWORK_RADIUS_M ?? 3000);
const KM_PER_DAY = 40;

const SEED = { lat: 43.6766, lon: 4.6278 };

// Esri serves a tile in about 16ms, but the browser refetches every tile on
// every reload. Cached here they come back off disk, and Esri is asked for each
// one exactly once.
// ponytail: cache grows without bound (tiles are 5-20kB); delete the directory
// if it ever matters, or add an age sweep.
const TILE_CACHE = process.env.TILE_CACHE ?? "tiles";
const TILE_SERVICES: Record<string, string> = {
  imagery: "World_Imagery",
  topo: "World_Topo_Map",
  dark: "Canvas/World_Dark_Gray_Base",
  light: "Canvas/World_Light_Gray_Base",
};
const tileStats = { hit: 0, miss: 0, failed: 0 };

const tileInFlight = new Map<string, Promise<Buffer>>();

/**
 * A complete PNG or JPEG. The trailer matters as much as the magic: a file left
 * half-written by an earlier, non-atomic save still starts with valid magic and
 * would be served forever as a broken tile.
 */
function looksLikeImage(b: Buffer): boolean {
  if (b.length < 1024) return false;
  if (b[0] === 0xff && b[1] === 0xd8) return b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
  if (b[0] === 0x89 && b[1] === 0x50) return b.subarray(-8, -4).toString("latin1") === "IEND";
  return false;
}

async function fetchTile(service: string, key: string, file: string, z: number, y: number, x: number) {
  const pending = tileInFlight.get(key);
  if (pending) return pending;

  const job = (async () => {
    const upstream = await fetch(
      `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/${z}/${y}/${x}`,
      { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) },
    );
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    // Written through a temporary name: writeFileSync is not atomic, and the
    // first page load asks for eighty tiles at once, so a concurrent reader
    // would otherwise catch a half-written file.
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, file);
    return bytes;
  })().finally(() => tileInFlight.delete(key));

  tileInFlight.set(key, job);
  return job;
}

async function serveTile(query: URLSearchParams, res: import("node:http").ServerResponse) {
  const name = query.get("s") ?? "";
  const service = TILE_SERVICES[name];
  const [z, y, x] = ["z", "y", "x"].map((k) => Number(query.get(k)));
  if (!service || ![z, y, x].every((n) => Number.isInteger(n) && n >= 0)) {
    res.writeHead(400).end();
    return;
  }

  const file = join(TILE_CACHE, name, String(z), String(y), `${x}.bin`);
  const key = `${name}/${z}/${y}/${x}`;
  let bytes: Buffer;
  try {
    const cached = existsSync(file) ? readFileSync(file) : null;
    if (cached && looksLikeImage(cached)) {
      bytes = cached;
      tileStats.hit++;
    } else {
      bytes = await fetchTile(service, key, file, z, y, x);
      tileStats.miss++;
    }
  } catch {
    tileStats.failed++;
    res.writeHead(502).end();
    return;
  }

  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  res.writeHead(200, {
    "Content-Type": png ? "image/png" : "image/jpeg",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(bytes);
}

interface Way {
  id: number;
  name: string;
  kind: string;
  character: string;
  roundabout: boolean;
  nodes: number[];
  geom: { lat: number; lon: number }[];
}

interface Network {
  center: { lat: number; lon: number };
  radiusM: number;
  ways: Map<number, Way>;
  nodeWays: Map<number, number[]>;
}

/** A move away from a node: travel along `wayId` from index `idx` toward `idx + dir`. */
interface Step {
  wayId: number;
  idx: number;
  dir: 1 | -1;
}

interface Place {
  name: string;
  kind: string;
  lat: number;
  lon: number;
}

interface Branch extends Step {
  id: string;
  road: string;
  kind: string;
  direction: string;
  bearingDeg: number;
  /** Whether this road leads over ground the walk has already covered. */
  ground?: string;
  /** What lies out that way, so unnamed lanes are not interchangeable. */
  leads?: string;
  /** The road itself for a short way ahead, so a spoke can follow it. */
  preview: [number, number][];
  probability?: number;
}

interface Waypoint {
  t: string;
  path: [number, number][];
  km: number;
  stopped: "fork" | "dead end" | "out of road" | "budget";
  place?: string;
  country?: string | null;
  terrain?: string;
  step?: Step;
  from?: number | null;
  branches?: Branch[];
  chosen?: string;
  chosenId?: string;
  backProbability?: number;
  confidence?: number;
  remoteness?: number;
  wanderlust?: number;
  circling?: number;
}

// Ground already covered, as ~33m cells counting how many legs crossed each.
// Jev cannot tell it is going in circles from road names alone — most of them
// are "an unnamed unclassified" — so code has to hand it the geography.
const CELL_DEG = 0.0003;
const cellKey = (lat: number, lon: number): string => {
  const y = Math.round(lat / CELL_DEG);
  const x = Math.round(lon / (CELL_DEG / Math.max(0.15, Math.cos((lat * Math.PI) / 180))));
  return `${y}:${x}`;
};

const walkedCells = new Map<string, number>();
function markWalked(path: [number, number][]) {
  const cells = new Set(path.map(([lat, lon]) => cellKey(lat, lon)));
  for (const cell of cells) walkedCells.set(cell, (walkedCells.get(cell) ?? 0) + 1);
}

function groundAhead(preview: [number, number][]): string {
  if (preview.length < 2) return "unknown ground";
  const cells = new Set(preview.map(([lat, lon]) => cellKey(lat, lon)));
  let seen = 0;
  let most = 0;
  for (const cell of cells) {
    const times = walkedCells.get(cell) ?? 0;
    if (times > 0) seen++;
    most = Math.max(most, times);
  }
  const fraction = seen / cells.size;
  if (fraction < 0.25) return "ground not walked before";
  if (fraction < 0.75) return "partly over ground already walked";
  return most > 2 ? `ground already walked ${most} times` : "ground already walked once";
}

function recentGround(): string {
  const recent = journey.slice(-12);
  if (!recent.length) return "nothing walked yet";
  const km = recent.reduce((sum, w) => sum + w.km, 0);
  const cells = new Set<string>();
  for (const w of recent) for (const [lat, lon] of w.path) cells.add(cellKey(lat, lon));
  let fresh = 0;
  for (const cell of cells) if ((walkedCells.get(cell) ?? 0) <= 1) fresh++;
  const newKm = (fresh / Math.max(1, cells.size)) * km;
  return `of the last ${km.toFixed(1)} km walked, about ${newKm.toFixed(1)} km was over ground not walked before`;
}

const journey: Waypoint[] = [];
let walker: Step | null = null;
let position = { ...SEED };
let arrivedFrom: number | null = null;
let paused = false;
let lastError: string | null = null;

if (existsSync(JOURNAL)) {
  for (const line of readFileSync(JOURNAL, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const w = JSON.parse(line) as Waypoint;
      journey.push(w);
      markWalked(w.path);
    } catch {
      lastError = "skipped a malformed journal line";
    }
  }
  const last = journey.at(-1);
  const tail = last?.path.at(-1);
  if (tail) position = { lat: tail[0], lon: tail[1] };
  // Restoring the heading matters now: without it a restart would snap the
  // walker to the nearest road facing an arbitrary way.
  if (last?.step) {
    walker = last.step;
    arrivedFrom = last.from ?? null;
  }
}

const client = new TypeSafeClient();

let requestFloor = 0;
async function politeFetch(url: string, minGapMs: number, init?: RequestInit): Promise<Response> {
  const wait = requestFloor - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  requestFloor = Date.now() + minGapMs;
  return fetch(url, { ...init, headers: { "User-Agent": USER_AGENT, ...(init?.headers ?? {}) } });
}

// ponytail: unbounded cache keyed by rounded coords; a single ambient process
// never grows it past a few thousand entries. Swap for an LRU if it does.
const placeCache = new Map<string, { place: string; country: string | null; terrain: string }>();

async function describePosition(lat: number, lon: number) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = placeCache.get(key);
  if (hit) return hit;

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&lat=${lat}&lon=${lon}`;
  let described = { place: "unnamed ground", country: null as string | null, terrain: "off the map" };
  try {
    const res = await politeFetch(url, 1100);
    const body = (await res.json()) as any;
    if (body?.address) {
      const a = body.address;
      const locality =
        a.village ?? a.town ?? a.city ?? a.municipality ?? a.suburb ?? a.county ?? a.state ?? body.name;
      described = {
        place: [locality, a.county, a.country].filter(Boolean).join(", ") || body.display_name,
        country: a.country ?? null,
        terrain:
          [body.category, body.type, a.state]
            .filter((t) => t && !["boundary", "administrative", "place"].includes(t))
            .join(", ") || "inland",
      };
    }
  } catch (e) {
    lastError = `nominatim: ${(e as Error).message}`;
  }
  placeCache.set(key, described);
  return described;
}

// ponytail: exactly one network in memory, refetched when the walker nears its
// edge. Bounded by construction; no eviction policy to get wrong.
let network: Network | null = null;

// Named places within reach, so a branch can be described by where it heads
// rather than only by its compass direction. Out here almost every road is "an
// unnamed unclassified" and without this there is nothing to choose between
// them. Cached by rounded coordinates; one Overpass call serves many ticks.
const placeCacheByCell = new Map<string, Place[]>();

async function placesAround(lat: number, lon: number): Promise<Place[]> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = placeCacheByCell.get(key);
  if (hit) return hit;

  const query =
    `[out:json][timeout:60];node["place"~"^(city|town|village|hamlet|suburb)$"]["name"]` +
    `(around:9000,${lat},${lon});out 60;`;
  let places: Place[] = [];
  for (const endpoint of OVERPASS) {
    try {
      const res = await politeFetch(endpoint, 1100, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as any;
      if (body.remark) throw new Error(body.remark);
      places = ((body.elements ?? []) as any[])
        .filter((e) => e.tags?.name)
        .map((e) => ({ name: e.tags.name as string, kind: e.tags.place as string, lat: e.lat, lon: e.lon }));
      break;
    } catch (e) {
      lastError = `overpass places: ${(e as Error).message}`;
    }
  }
  placeCacheByCell.set(key, places);
  return places;
}

/** The nearest named place lying roughly down this branch's bearing. */
function leadsToward(from: { lat: number; lon: number }, headingDeg: number, places: Place[]): string {
  let best: { place: Place; km: number } | null = null;
  for (const place of places) {
    const km = distanceKm(from.lat, from.lon, place.lat, place.lon);
    if (km < 0.2) continue;
    if (turn(headingDeg, bearing(from.lat, from.lon, place.lat, place.lon)) > 55) continue;
    if (!best || km < best.km) best = { place, km };
  }
  if (!best) return "open country, no settlement that way";
  return `toward ${best.place.name}, a ${best.place.kind} ${Math.round(best.km)}km off`;
}

async function fetchNetwork(lat: number, lon: number): Promise<Network | null> {
  const query =
    `[out:json][timeout:90];way["highway"~"^(${ROADS})$"]` +
    `(around:${NETWORK_RADIUS_M},${lat},${lon});out geom;`;

  let elements: any[] | null = null;
  for (const endpoint of OVERPASS) {
    try {
      const res = await politeFetch(endpoint, 1100, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as any;
      // Overpass reports its own timeouts as a 200 with a `remark`, not an HTTP error.
      if (body.remark) throw new Error(body.remark);
      elements = body.elements ?? [];
      break;
    } catch (e) {
      lastError = `overpass ${new URL(endpoint).host}: ${(e as Error).message}`;
    }
  }
  if (!elements) return null;

  const ways = new Map<number, Way>();
  const nodeWays = new Map<number, number[]>();
  for (const el of elements) {
    if (!el.nodes || !el.geometry || el.nodes.length !== el.geometry.length) continue;
    ways.set(el.id, {
      id: el.id,
      name: el.tags?.name ?? el.tags?.ref ?? "",
      kind: el.tags?.highway ?? "road",
      character: wayCharacter(el.tags ?? {}),
      roundabout: el.tags?.junction === "roundabout" || el.tags?.junction === "circular",
      nodes: el.nodes,
      geom: el.geometry,
    });
    for (const node of el.nodes) {
      const list = nodeWays.get(node);
      if (list) list.push(el.id);
      else nodeWays.set(node, [el.id]);
    }
  }
  lastError = null;
  return { center: { lat, lon }, radiusM: NETWORK_RADIUS_M, ways, nodeWays };
}

/**
 * Whatever OpenStreetMap knows about a road beyond its classification. Most
 * roads out here are unnamed, so without this every branch reads as "an unnamed
 * unclassified" and there is nothing for Jev to tell them apart by.
 */
function wayCharacter(tags: Record<string, string>): string {
  const parts: string[] = [];
  if (tags.bridge && tags.bridge !== "no") parts.push("on a bridge");
  if (tags.tunnel && tags.tunnel !== "no") parts.push("through a tunnel");
  if (tags.ford && tags.ford !== "no") parts.push("across a ford");
  const surface = tags.surface ?? (tags.tracktype ? { grade1: "paved", grade2: "gravel", grade3: "earth", grade4: "grass", grade5: "sand" }[tags.tracktype] : undefined);
  if (surface) parts.push(surface.replace(/_/g, " "));
  if (tags.lit === "yes") parts.push("lit");
  if (tags.tree_lined === "yes" || tags.natural === "tree_row") parts.push("tree lined");
  if (tags.access === "private" || tags.access === "no") parts.push("private");
  if (tags.maxspeed && Number(tags.maxspeed) >= 90) parts.push("fast");
  return parts.join(", ");
}

function coordOf(net: Network, step: Step) {
  const way = net.ways.get(step.wayId)!;
  return way.geom[step.idx];
}

/** How sharp a turn still counts as carrying on rather than doubling back. */
const MAX_TURN_DEG = 135;

const stepBearing = (net: Network, step: Step): number => {
  const g = net.ways.get(step.wayId)!.geom;
  return bearing(g[step.idx].lat, g[step.idx].lon, g[step.idx + step.dir].lat, g[step.idx + step.dir].lon);
};

/**
 * Every move leaving `nodeId`, minus an immediate U-turn back to `cameFrom` and,
 * when a heading is given, minus anything that doubles back. On a dual
 * carriageway the opposite side is a different node, so excluding `cameFrom`
 * alone leaves a reversal on the table and the walk degenerates into a coin
 * flip between the two directions of one road.
 */
function onwardSteps(
  net: Network,
  nodeId: number,
  cameFrom: number | null,
  headingDeg?: number,
): Step[] {
  const seen = new Set<number>();
  const steps: Step[] = [];
  for (const wayId of net.nodeWays.get(nodeId) ?? []) {
    const way = net.ways.get(wayId);
    if (!way) continue;
    way.nodes.forEach((n, i) => {
      if (n !== nodeId) return;
      for (const dir of [1, -1] as const) {
        const j = i + dir;
        if (j < 0 || j >= way.nodes.length) continue;
        const next = way.nodes[j];
        if (next === cameFrom || seen.has(next)) continue;
        seen.add(next);
        steps.push({ wayId, idx: i, dir });
      }
    });
  }
  if (headingDeg === undefined) return steps;
  const onward = steps.filter((s) => turn(headingDeg, stepBearing(net, s)) <= MAX_TURN_DEG);
  return onward.length ? onward : steps;
}

const turn = (from: number, to: number): number => Math.abs((((to - from) % 360) + 540) % 360 - 180);

/**
 * The road ahead of a branch, followed across way boundaries by always taking
 * whichever way carries straight on. Without this a spoke's length would report
 * where OSM happened to split the way rather than how much Jev wanted it.
 */
function previewAhead(net: Network, start: Step, maxKm: number): [number, number][] {
  const origin = net.ways.get(start.wayId)?.geom[start.idx];
  if (!origin) return [];
  const points: [number, number][] = [[origin.lat, origin.lon]];
  let cur = start;
  let travelled = 0;

  for (let guard = 0; guard < 400 && travelled < maxKm; guard++) {
    const way = net.ways.get(cur.wayId);
    if (!way) break;
    const j = cur.idx + cur.dir;
    if (j < 0 || j >= way.nodes.length) break;

    const a = way.geom[cur.idx];
    const b = way.geom[j];
    travelled += distanceKm(a.lat, a.lon, b.lat, b.lon);
    points.push([b.lat, b.lon]);

    const heading = bearing(a.lat, a.lon, b.lat, b.lon);
    const onward = onwardSteps(net, way.nodes[j], way.nodes[cur.idx], heading);
    if (onward.length === 0) break;
    cur = onward.reduce((best, option) => {
      const at = (s: Step) => net.ways.get(s.wayId)!.geom[s.idx + s.dir];
      const angle = (s: Step) => turn(heading, bearing(b.lat, b.lon, at(s).lat, at(s).lon));
      return angle(option) < angle(best) ? option : best;
    });
  }
  return points;
}

function describeBranch(net: Network, from: { lat: number; lon: number }, step: Step, id: string): Branch {
  const way = net.ways.get(step.wayId)!;
  const next = way.geom[step.idx + step.dir];
  const b = bearing(from.lat, from.lon, next.lat, next.lon);

  return {
    ...step,
    id,
    road: way.name || `an unnamed ${way.kind.replace(/_/g, " ")}`,
    kind: [way.kind.replace(/_/g, " "), way.character].filter(Boolean).join(", "),
    direction: compassWord(b),
    bearingDeg: b,
    preview: previewAhead(net, step, SPOKE_MAX_KM),
  };
}

/** The first `km` of a polyline, cutting the final segment short. */
function truncate(points: [number, number][], km: number): [number, number][] {
  const out: [number, number][] = points.length ? [points[0]] : [];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = distanceKm(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    if (acc + seg >= km && seg > 0) {
      const f = (km - acc) / seg;
      out.push([
        points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f,
        points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f,
      ]);
      return out;
    }
    acc += seg;
    out.push(points[i]);
  }
  return out;
}

interface Leg {
  path: [number, number][];
  km: number;
  stopped: Waypoint["stopped"];
  at: { lat: number; lon: number };
  branches: Branch[];
}

/**
 * Follow the road from the walker's position. A node with one way onward is a
 * bend and is taken silently; a node with several is a fork and ends the leg.
 * A dead end reverses the walker rather than leaving the network.
 */
function walkToFork(net: Network, budgetKm: number, minLegKm: number): Leg {
  const path: [number, number][] = [];
  let km = 0;
  let here = coordOf(net, walker!);
  path.push([here.lat, here.lon]);

  for (let guard = 0; guard < 4000; guard++) {
    const way = net.ways.get(walker!.wayId);
    if (!way) return { path, km, stopped: "out of road", at: here, branches: [] };

    const nextIdx = walker!.idx + walker!.dir;
    if (nextIdx < 0 || nextIdx >= way.nodes.length) {
      return { path, km, stopped: "out of road", at: here, branches: [] };
    }

    const from = way.nodes[walker!.idx];
    const next = way.geom[nextIdx];
    const heading = bearing(here.lat, here.lon, next.lat, next.lon);
    km += distanceKm(here.lat, here.lon, next.lat, next.lon);
    here = next;
    path.push([next.lat, next.lon]);
    walker = { wayId: walker!.wayId, idx: nextIdx, dir: walker!.dir };
    arrivedFrom = from;

    const nodeId = way.nodes[nextIdx];
    const onward = onwardSteps(net, nodeId, arrivedFrom, heading);

    if (onward.length === 0) {
      walker = { ...walker, dir: (walker.dir * -1) as 1 | -1 };
      arrivedFrom = null;
      return { path, km, stopped: "dead end", at: here, branches: [] };
    }
    if (onward.length === 1) {
      walker = onward[0];
      if (km >= budgetKm) return { path, km, stopped: "budget", at: here, branches: [] };
      continue;
    }

    // Stopping at the very first fork means that in a dense junction every leg
    // is a few tens of metres, and the walk can sit in a 30m loop forever while
    // `circling` reads 0.96 and nothing can act on it. Below the minimum leg,
    // carry straight on past the side roads instead of deciding.
    //
    // Never on a roundabout though: there the straightest way on is always the
    // ring itself, so skipping forks means orbiting it until the minimum leg is
    // used up and never taking an exit at all.
    if (km < minLegKm && !net.ways.get(walker!.wayId)?.roundabout) {
      const straight = onward.reduce((best, option) => {
        const at = (s: Step) => net.ways.get(s.wayId)!.geom[s.idx + s.dir];
        const angle = (s: Step) => turn(heading, bearing(here.lat, here.lon, at(s).lat, at(s).lon));
        return angle(option) < angle(best) ? option : best;
      });
      walker = straight;
      continue;
    }

    return {
      path,
      km,
      stopped: "fork",
      at: here,
      branches: onward.map((s, i) => describeBranch(net, here, s, `r${i + 1}`)),
    };
  }
  return { path, km, stopped: "budget", at: here, branches: [] };
}

const WANDERLUST = [
  "Content to linger. The next stretch should be a short amble to the end of this street.",
  "Curious about the immediate surroundings. The next stretch should cover a village or a few fields.",
  "Wants to make ground today. The next stretch should cover a long run of open road.",
  "Pulled toward the horizon. The next stretch should be as much road as can be covered before dark.",
] as const;

const WANDERLUST_LABELS = ["lingering", "curious", "making ground", "for the horizon"] as const;
const REMOTENESS_LABELS = ["city", "farmland", "wild", "empty"] as const;

const REMOTENESS = [
  "A dense city centre, continuous streets and buildings in every direction.",
  "Farmland, villages and roads; a town is always within an hour.",
  "Mountain, forest, steppe or desert with a scattering of small settlements and long empty stretches between them.",
  "Open ocean, ice sheet or deep interior desert with no settlement for hundreds of kilometres.",
] as const;

interface JevState {
  [key: string]: JsonValue;
  current_location: string;
  terrain: string;
  road_travelled: string;
  recent_ground: string;
  days_travelling: number;
  branches: { id: string; road: string; kind: string; direction: string; ground: string; leads: string }[];
}

async function decide(state: JevState, branches: Branch[]) {
  // No "none of these" here. The original design had it because the candidates
  // were distant places that might all be poor; a walker standing at a junction
  // has to take a road. Offered the choice, it turned back at eight forks in a
  // row in a pocket where every exit was already walked — each reversal adding
  // to the retrace count it was trying to escape. Dead ends still reverse, in
  // code, without asking.
  const criteria: Record<string, string> = {};
  for (const b of branches) {
    criteria[b.id] = `${b.road} — a ${b.kind} heading ${b.direction}, ${b.leads}, over ${b.ground}`;
  }

  return await client.systemOne({
    state,
    questions: {
      next_road: choice(
        "A traveller is walking across the world on foot with no destination and no schedule, taking whichever road looks more interesting than the one they are on. They have reached a fork. Which road do they take?",
        criteria,
      ),
      wanderlust: score(
        "How much ground does this traveller want to cover right now, given where they are and the roads they have just walked?",
        WANDERLUST,
      ),
      circling: noul("Has this journey been going in circles around one area?", {
        true: "Most of the recent walking has been back over ground already covered.",
        false: "Most of the recent walking has been over ground not covered before.",
      }),
      remoteness: score("How wild and remote is `current_location`?", REMOTENESS),
    },
  });
}

async function ensureNetwork(): Promise<Network | null> {
  const stale =
    !network ||
    distanceKm(network.center.lat, network.center.lon, position.lat, position.lon) * 1000 >
      network.radiusM * 0.45;
  if (stale) {
    const fetched = await fetchNetwork(position.lat, position.lon);
    if (fetched) network = fetched;
  }
  return network;
}

/** Put the walker on the road nearest to `position`, at the start of a run. */
function placeWalker(net: Network) {
  let nearest: Step | null = null;
  let nearestKm = Infinity;
  for (const way of net.ways.values()) {
    for (let i = 0; i + 1 < way.geom.length; i++) {
      const d = distanceKm(position.lat, position.lon, way.geom[i].lat, way.geom[i].lon);
      if (d < nearestKm) {
        nearestKm = d;
        nearest = { wayId: way.id, idx: i, dir: 1 };
      }
    }
  }
  if (!nearest) return;
  walker = nearest;
  arrivedFrom = null;
  position = coordOf(net, nearest);
}

function record(waypoint: Waypoint) {
  waypoint.step = walker ?? undefined;
  waypoint.from = arrivedFrom;
  appendFileSync(JOURNAL, JSON.stringify(waypoint) + "\n");
  journey.push(waypoint);
}

async function tick() {
  const net = await ensureNetwork();
  if (!net) return;
  if (!walker || !net.ways.get(walker.wayId)?.nodes[walker.idx]) placeWalker(net);
  if (!walker) {
    lastError = "no road within reach of the walker";
    return;
  }

  // wanderlust sets how much ground it wants to cover; circling stretches that,
  // so a walk that keeps retracing itself commits to longer runs between forks.
  const judged = journey.findLast((w) => w.stopped === "fork");
  const circling = judged?.circling ?? 0;
  const budget = STEP_KM * (0.4 + 0.6 * ((judged?.wanderlust ?? 1.5) / 3)) * (1 + 2 * circling);
  // How far it must go before it will stop to choose again. This is what
  // `circling` drives: the more it is retracing, the further it commits before
  // entertaining another junction.
  const leg = walkToFork(net, budget, Math.min(budget * 0.8, 0.12 + 1.2 * circling));
  position = leg.at;

  if (leg.stopped !== "fork") {
    record({ t: new Date().toISOString(), path: leg.path, km: leg.km, stopped: leg.stopped });
    return;
  }

  markWalked(leg.path);
  const places = await placesAround(position.lat, position.lon);
  for (const b of leg.branches) {
    b.ground = groundAhead(b.preview);
    b.leads = leadsToward(position, b.bearingDeg, places);
  }

  const here = await describePosition(position.lat, position.lon);
  const state: JevState = {
    current_location: here.place,
    terrain: here.terrain,
    road_travelled: net.ways.get(walker.wayId)?.name || `an unnamed ${net.ways.get(walker.wayId)?.kind}`,
    recent_ground: recentGround(),
    days_travelling: Math.round(journey.reduce((sum, w) => sum + w.km, 0) / KM_PER_DAY),
    branches: leg.branches.map(({ id, road, kind, direction, ground, leads }) => ({
      id, road, kind, direction, ground: ground ?? "unknown ground", leads: leads ?? "",
    })),
  };

  const { answers } = await decide(state, leg.branches);
  const probabilities = answers.next_road.probabilities as Record<string, number>;
  for (const b of leg.branches) b.probability = probabilities[b.id] ?? 0;

  const taken =
    leg.branches.find((b) => b.id === answers.next_road.choice) ??
    leg.branches.reduce((best, b) => ((b.probability ?? 0) > (best.probability ?? 0) ? b : best));

  walker = { wayId: taken.wayId, idx: taken.idx, dir: taken.dir };

  record({
    t: new Date().toISOString(),
    path: leg.path,
    km: leg.km,
    stopped: "fork",
    place: here.place,
    country: here.country,
    terrain: here.terrain,
    branches: leg.branches,
    chosen: taken.road,
    chosenId: answers.next_road.choice,
    backProbability: probabilities.back ?? 0,
    confidence: answers.next_road.confidence,
    remoteness: answers.remoteness.score,
    wanderlust: answers.wanderlust.score,
    circling: answers.circling.noul,
  });
}

async function loop() {
  for (;;) {
    if (!paused) {
      try {
        await tick();
      } catch (e) {
        lastError = (e as Error).message;
        console.error("tick failed:", lastError);
      }
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

// Rebuilt only when a leg lands, not on every poll: walking the whole journey
// and allocating a fresh array of every point thirty times a minute is pure
// waste once the trace runs to thousands of points.
let fullTrace: [number, number, number][] = [];
let fullTraceLegStart = 0;
let fullTraceFor = -1;

function buildFullTrace() {
  if (fullTraceFor === journey.length) return;
  const points: [number, number, number][] = [];
  let remoteness = 0;
  let legStart = 0;
  for (const w of journey) {
    legStart = Math.max(0, points.length - 1);
    if (w.remoteness !== undefined) remoteness = w.remoteness;
    for (const p of w.path) {
      const prev = points.at(-1);
      if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
      points.push([p[0], p[1], remoteness]);
    }
  }
  fullTrace = points;
  fullTraceLegStart = legStart;
  fullTraceFor = journey.length;
}

function snapshot(since: number) {
  const decided = journey.findLast((w) => w.stopped === "fork");
  const totalKm = journey.reduce((sum, w) => sum + w.km, 0);
  buildFullTrace();
  const full = fullTrace;
  const legStart = fullTraceLegStart;
  // The browser keeps the trace it already has and asks for what is new.
  const from = Math.min(Math.max(0, since), full.length);
  const trace = full.slice(from);

  const strongest = Math.max(0.001, ...(decided?.branches ?? []).map((b) => b.probability ?? 0));

  return {
    paused,
    error: lastError,
    position,
    place: decided?.place ?? "setting out",
    terrain: decided?.terrain ?? "",
    road: journey.at(-1)?.chosen ?? "",
    stopped: journey.at(-1)?.stopped ?? "",
    trace,
    traceFrom: from,
    traceTotal: full.length,
    // Where the walker started its current leg, so the browser can animate it
    // along instead of teleporting to the next fork.
    legStart,
    tickMs: TICK_MS,
    origin: decided?.path.at(-1) ?? [position.lat, position.lon],
    branches: (decided?.branches ?? []).map((b) => ({
      road: b.road,
      kind: b.kind,
      direction: b.direction,
      ground: b.ground ?? "",
      leads: b.leads ?? "",
      // The spoke is the candidate road itself, lit for a distance
      // proportional to how much Jev wanted it.
      line: truncate(b.preview ?? [], 0.08 + 0.37 * ((b.probability ?? 0) / strongest)),
      probability: b.probability ?? 0,
      chosen: b.id === decided?.chosenId,
    })),
    back: decided?.backProbability ?? 0,
    // Whether that decision is the leg being walked right now. When the last
    // leg ended for another reason — budget, dead end — the spokes belong to an
    // older junction and must not be drawn at the walker.
    decisionIsCurrent: journey.at(-1) === decided,
    confidence: decided?.confidence ?? 0,
    remoteness: decided?.remoteness ?? 0,
    wanderlust: decided?.wanderlust ?? 0,
    circling: decided?.circling ?? 0,
    scales: { wanderlust: WANDERLUST_LABELS, remoteness: REMOTENESS_LABELS },
    feed: journey
      .filter((w) => w.stopped === "fork")
      .slice(-16)
      .reverse()
      .map((w) => ({
        t: w.t,
        road: w.chosen ?? "",
        confidence: w.confidence ?? 0,
        km: w.km,
        circling: w.circling ?? 0,
      })),
    stats: {
      km: Math.round(totalKm * 10) / 10,
      forks: journey.filter((w) => w.stopped === "fork").length,
      days: Math.round(totalKm / KM_PER_DAY),
      countries: new Set(journey.map((w) => w.country).filter(Boolean)).size,
    },
  };
}

const page = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");

createServer((req, res) => {
  const [path, query] = (req.url ?? "/").split("?");
  if (path === "/api/state") {
    const since = Number(new URLSearchParams(query ?? "").get("since"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snapshot(Number.isFinite(since) ? since : 0)));
  } else if (path === "/api/pause" && req.method === "POST") {
    paused = !paused;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ paused }));
  } else if (path === "/tile") {
    // A rejected promise here would leave the response open forever. Firefox
    // allows about six connections per host, so a handful of hung tiles stalls
    // the whole page — tiles, journey polling and all.
    serveTile(new URLSearchParams(query ?? ""), res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  } else if (path === "/tilestats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(tileStats));
  } else if (path === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
  } else {
    res.writeHead(404).end();
  }
}).listen(PORT, () => console.log(`walking at http://localhost:${PORT}`));

loop();
