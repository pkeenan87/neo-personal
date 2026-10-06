/**
 * IP geolocation seam for sign-in alerts (_specs/signin-alerts.md). Mock only: no hosted or local adapter
 * is in scope, and nothing here touches the network. IP-derived locations are advisory (an IP can be a VPN,
 * a carrier gateway or attacker-supplied), and the UI labels them so.
 */
export interface GeoLocator {
  locate(ip: string): Promise<{ coarseLocation?: string; advisory: true }>;
}

/** RFC 5737 documentation ranges map to a fixed label; every other address has no location. Deterministic. */
export const mockGeoLocator: GeoLocator = {
  async locate(ip) {
    if (/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(ip)) return { coarseLocation: "Documentation network (mock)", advisory: true };
    return { advisory: true };
  },
};
