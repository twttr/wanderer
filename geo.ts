const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

export function normalizeLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function destination(
  lat: number,
  lon: number,
  distanceKm: number,
  bearingDeg: number,
): { lat: number; lon: number } {
  const angular = distanceKm / EARTH_RADIUS_KM;
  const bearing = toRadians(bearingDeg);
  const lat1 = toRadians(lat);
  const lon1 = toRadians(lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lat: toDegrees(lat2), lon: normalizeLongitude(toDegrees(lon2)) };
}

export function distanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const p1 = toRadians(lat1);
  const p2 = toRadians(lat2);
  const dLon = toRadians(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = [
  "north", "northeast", "east", "southeast",
  "south", "southwest", "west", "northwest",
];

export function compassWord(bearingDeg: number): string {
  return COMPASS[Math.round(((bearingDeg % 360) + 360) % 360 / 45) % 8];
}
