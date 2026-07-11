import { calculateDistance, isWithinZone, isWithinRadius, buildBoundingBoxFilter } from "../../src/services/geoService";

describe("geoService", () => {
  describe("calculateDistance", () => {
    it("returns 0 for same coordinates", () => {
      expect(calculateDistance(0, 0, 0, 0)).toBe(0);
    });

    it("calculates distance between Nairobi and Mombasa", () => {
      const dist = calculateDistance(-1.2921, 36.8219, -4.0435, 39.6682);
      expect(dist).toBeGreaterThan(300);
      expect(dist).toBeLessThan(500);
    });

    it("calculates distance between London and Paris", () => {
      const dist = calculateDistance(51.5074, -0.1278, 48.8566, 2.3522);
      expect(dist).toBeGreaterThan(300);
      expect(dist).toBeLessThan(400);
    });
  });

  describe("isWithinZone", () => {
    it("returns true for point at center", () => {
      expect(isWithinZone(-1.2921, 36.8219, -1.2921, 36.8219, 1)).toBe(true);
    });

    it("returns false for point far away", () => {
      expect(isWithinZone(-1.2921, 36.8219, 51.5074, -0.1278, 1)).toBe(false);
    });

    it("returns true for point within radius", () => {
      expect(isWithinZone(-1.2921, 36.8219, -1.2931, 36.8229, 1)).toBe(true);
    });
  });

  describe("isWithinRadius", () => {
    it("converts meters to km correctly", () => {
      expect(isWithinRadius(-1.2921, 36.8219, -1.2921, 36.8219, 100)).toBe(true);
    });

    it("returns false for distance exceeding radius", () => {
      expect(isWithinRadius(-1.2921, 36.8219, 51.5074, -0.1278, 100)).toBe(false);
    });
  });

  describe("buildBoundingBoxFilter", () => {
    it("returns undefined when params are missing", () => {
      expect(buildBoundingBoxFilter()).toBeUndefined();
      expect(buildBoundingBoxFilter(40, undefined, 41, -73)).toBeUndefined();
    });

    it("returns correct bounding box filter", () => {
      const filter = buildBoundingBoxFilter(40.7, -74.01, 40.75, -73.98);
      expect(filter).toEqual({
        lat: { gte: 40.7, lte: 40.75 },
        lng: { gte: -74.01, lte: -73.98 },
      });
    });
  });
});
