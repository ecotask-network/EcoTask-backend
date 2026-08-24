export function calculateDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isWithinZone(
  lat: number,
  lng: number,
  centerLat: number,
  centerLng: number,
  radiusKm: number,
): boolean {
  return calculateDistance(lat, lng, centerLat, centerLng) <= radiusKm;
}

export function isWithinRadius(
  lat: number,
  lng: number,
  centerLat: number,
  centerLng: number,
  radiusMeters: number,
): boolean {
  return isWithinZone(lat, lng, centerLat, centerLng, radiusMeters / 1000);
}

export function buildBoundingBoxFilter(
  swLat?: number,
  swLng?: number,
  neLat?: number,
  neLng?: number,
): Record<string, object> | undefined {
  if (swLat == null || swLng == null || neLat == null || neLng == null) return undefined;

  const lat = { gte: swLat, lte: neLat };

  // When the viewport crosses the antimeridian (swLng > neLng, e.g. a
  // search window of 170 -> -170), a single `lng BETWEEN swLng AND neLng`
  // predicate matches nothing. Split into the two valid hemispheres:
  // (swLng .. 180] union [-180 .. neLng].
  const lng =
    swLng <= neLng
      ? { gte: swLng, lte: neLng }
      : { OR: [{ gte: swLng }, { lte: neLng }] };

  return { lat, lng };
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
