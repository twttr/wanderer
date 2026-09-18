import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerResponse } from "node:http";
import { USER_AGENT } from "./config.ts";

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
export const tileStats = { hit: 0, miss: 0, failed: 0 };

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

export async function serveTile(query: URLSearchParams, res: ServerResponse) {
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
