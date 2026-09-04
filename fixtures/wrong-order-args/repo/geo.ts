export interface Point { lat: number; lon: number }

/** Great-circle distance in kilometres. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

export function nearest(from: Point, candidates: Point[]): Point | null {
  let best: Point | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = distanceKm(from.lat, from.lon, c.lon, c.lat);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}
