import test from "node:test";
import assert from "node:assert/strict";
import { bearing, compassWord, destination, distanceKm, normalizeLongitude } from "./geo.ts";

test("111km north of the origin lands near one degree of latitude", () => {
  const p = destination(0, 0, 111.195, 0);
  assert.ok(Math.abs(p.lat - 1) < 0.01, `lat was ${p.lat}`);
  assert.ok(Math.abs(p.lon) < 1e-9, `lon was ${p.lon}`);
});

test("moving east across the antimeridian wraps to negative longitude", () => {
  const p = destination(0, 179, 500, 90);
  assert.ok(p.lon < 0, `lon was ${p.lon}`);
  assert.ok(p.lon >= -180 && p.lon <= 180);
  assert.ok(Math.abs(p.lon + 176.5) < 0.5, `lon was ${p.lon}`);
});

test("crossing the pole yields a valid latitude", () => {
  const p = destination(85, 10, 1500, 0);
  assert.ok(Math.abs(p.lat) <= 90, `lat was ${p.lat}`);
  assert.ok(p.lat < 85, `expected to come down the far side, got ${p.lat}`);
  assert.ok(Math.abs(normalizeLongitude(p.lon) - -170) < 1e-6, `lon was ${p.lon}`);
});

test("distance and bearing round-trip through destination", () => {
  const from = { lat: 43.68, lon: 4.63 };
  const to = { lat: 43.3, lon: 5.37 };
  const p = destination(from.lat, from.lon, distanceKm(from.lat, from.lon, to.lat, to.lon), bearing(from.lat, from.lon, to.lat, to.lon));
  assert.ok(Math.abs(p.lat - to.lat) < 1e-6 && Math.abs(p.lon - to.lon) < 1e-6);
});

test("compass words name the eight sectors", () => {
  assert.equal(compassWord(0), "north");
  assert.equal(compassWord(135), "southeast");
  assert.equal(compassWord(350), "north");
});
