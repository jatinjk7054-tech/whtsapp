// Pure helpers for scoping a station donor list to one NGO.
//
// A station NAME is not unique to an NGO. The same name is reused across NGOs
// and only the displayed code differs: 'DH-5' is BOD-15 for BSCT, AOD-15 for
// AFLF and MOD-15 for MANN. An NGO admin's access resolves to *every* NGO
// (getUserNgoAccess short-circuits role 'admin' to all NGOs), so looking a
// station up by name alone silently unions unrelated stations.
//
// These are split out of ngoAdminController.getDonorsByStation so the two
// decisions that caused the wrong donor counts - which NGOs to query, and what
// counts as a duplicate row - are testable without a database.

/**
 * Decide which NGO ids to query for a station donor list.
 *
 * Omitting requestedNgoId keeps the cross-NGO union for surfaces that genuinely
 * want it (super-admin dashboard, accounts old data). Supplying it narrows to
 * that single NGO, which is what every per-station surface wants.
 *
 * Values are returned as given rather than stringified, because the caller feeds
 * them straight into a query builder where the original type matters. Only the
 * comparison is done on string form: ids arrive as numbers from some access rows
 * and as strings from the query string, and '7' !== 7 would refuse a legitimate
 * request.
 *
 * @returns {{ ok: true, ids: any[] } | { ok: false, message: string }}
 */
export const resolveStationNgoScope = (accessibleIds, requestedNgoId) => {
  const ids = (accessibleIds || []).filter(id => id !== null && id !== undefined && id !== '');

  if (!requestedNgoId) return { ok: true, ids };

  const requested = String(requestedNgoId);
  const hit = ids.find(id => String(id) === requested);
  if (hit === undefined) {
    return { ok: false, message: 'No NGO access for the requested ngo_id' };
  }
  return { ok: true, ids: [hit] };
};

/**
 * Collapse repeated assignment rows to one per (ngo, donor).
 *
 * The key must include ngo_id. A donor legitimately assigned in two NGOs is two
 * distinct leads with two distinct FROs; keying on donor_id alone dropped one of
 * them and, because the survivor was whichever NGO happened to be iterated
 * first, reported that other NGO's FRO, status and dates for it.
 */
export const dedupeStationDonors = (rows) => {
  const seen = new Set();
  return (rows || []).filter(r => {
    const key = `${r.ngo_id}::${r.donor_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Resolve display names for ngo ids, preferring names already in hand.
 *
 * access rows carry ngo_name, but an NGO resolved from req.user.ngo_id (the
 * fallback when access comes back empty) has no name yet, and an empty name is
 * what makes a unioned row impossible to attribute.
 *
 * @param {Array<{ngo_id: any, ngo_name?: string}>} access
 * @param {Array<string>} ngoIds ids actually being queried
 * @returns {Array<string>} ids whose name is still unknown
 */
export const ngoIdsMissingNames = (access, ngoIds) => {
  const known = new Set(
    (access || [])
      .filter(a => a && a.ngo_id && a.ngo_name)
      .map(a => String(a.ngo_id))
  );
  return (ngoIds || []).filter(id => id && !known.has(String(id)));
};
