// Fixed international / UN observance days for the "Important Days" calendar.
// A separate, deterministic source from Calendarific: these are hardcoded
// month/day rules, so they render for ANY year with zero API calls, and they
// ship in the deploy (the server does not need to reach Calendarific for them).
//
// Merging: the Important Days endpoint merges this list after the curated
// observances.js rows. Overlaps with identical date+name are dropped (curated
// wins), so nothing is ever shown twice — every day here was checked against the
// curated file before being added, so this list is complementary, not a copy.
//
// Mirror of observances.js FIXED rows, WITHOUT `scope`/`kind` because a fixed
// international day is always scope 'worldwide', kind 'observance'.

const INTERNATIONAL_DAYS = [
  /* February */
  { m: 2, d: 4, name: 'International Day of Human Fraternity', themes: ['rights', 'community'] },
  { m: 2, d: 21, name: 'International Mother Language Day', themes: ['education'] },
  /* March */
  { m: 3, d: 21, name: 'International Day for the Elimination of Racial Discrimination', themes: ['rights', 'social-inclusion'] },
  /* April */
  { m: 4, d: 12, name: 'International Day of Human Space Flight', themes: ['education', 'technology'] },
  { m: 4, d: 26, name: 'World Intellectual Property Day', themes: ['education', 'technology', 'livelihoods'] },
  /* May */
  { m: 5, d: 1, name: "International Workers' Day", themes: ['livelihoods', 'rights'] },
  { m: 5, d: 29, name: 'International Day of UN Peacekeepers', themes: ['rights', 'community'] },
  { m: 5, d: 31, name: 'World No Tobacco Day', themes: ['health'] },
  /* June */
  { m: 6, d: 1, name: 'International Day of Innocent Children Victims of Aggression', themes: ['children', 'rights'] },
  { m: 6, d: 12, name: 'International Day Against Child Labour', themes: ['children', 'livelihoods', 'rights'] },
  { m: 6, d: 21, name: 'International Day of Yoga', themes: ['health', 'sports-culture'] },
  { m: 6, d: 23, name: "International Widows' Day", themes: ['women-children', 'rights', 'social-inclusion'] },
  { m: 6, d: 26, name: 'International Day against Drug Abuse and Illicit Trafficking', themes: ['health', 'youth'] },
  /* July */
  { m: 7, d: 15, name: 'World Youth Skills Day', themes: ['youth', 'livelihoods', 'education'] },
  { m: 7, d: 30, name: 'International Day of Friendship', themes: ['community', 'social-inclusion'] },
  /* August */
  { m: 8, d: 9, name: "International Day of the World's Indigenous Peoples", themes: ['rights', 'social-inclusion'] },
  { m: 8, d: 23, name: 'International Day for the Remembrance of the Slave Trade', themes: ['rights', 'education'] },
  /* September */
  { m: 9, d: 15, name: 'International Day of Democracy', themes: ['rights', 'community'] },
  { m: 9, d: 27, name: 'World Tourism Day', themes: ['sports-culture', 'livelihoods', 'community'] },
  /* October — includes the "always show" anchor list (World Food Day, World
     Mental Health Day and UN Day live in observances.js, so these merge in as
     dedupes only when the curated file already carries them). */
  { m: 10, d: 1, name: 'International Day of Older Persons', themes: ['social-inclusion', 'health'] },
  { m: 10, d: 4, name: 'World Animal Day', themes: ['environment'] },
  { m: 10, d: 10, name: 'World Mental Health Day', themes: ['health'] },
  { m: 10, d: 15, name: 'International Day of Rural Women', themes: ['women-children', 'livelihoods'] },
  { m: 10, d: 16, name: 'World Food Day', themes: ['nutrition', 'livelihoods'] },
  { m: 10, d: 17, name: 'International Day for the Eradication of Poverty', themes: ['social-inclusion', 'rights', 'livelihoods'] },
  { m: 10, d: 24, name: 'United Nations Day', themes: ['rights', 'community'] },
  { m: 10, d: 31, name: 'World Cities Day', themes: ['community', 'environment'] },
  /* November */
  { m: 11, d: 10, name: 'World Science Day for Peace and Development', themes: ['education', 'technology'] },
  { m: 11, d: 16, name: 'International Day for Tolerance', themes: ['rights', 'social-inclusion'] },
  { m: 11, d: 21, name: 'World Philosophy Day', themes: ['education'] },
  /* December */
  { m: 12, d: 7, name: 'International Civil Aviation Day', themes: ['technology', 'education'] },
  { m: 12, d: 9, name: 'International Anti-Corruption Day', themes: ['rights', 'community'] },
  { m: 12, d: 18, name: 'International Migrants Day', themes: ['rights', 'social-inclusion'] },
];

const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Every fixed international day whose date falls inside [startYmd, endYmd)
 * (endYmd exclusive). Deterministic and independent of any API.
 */
export function getInternationalDaysInRange(startYmd, endYmd) {
  const out = [];
  const startDate = new Date(`${startYmd}T00:00:00Z`);
  const endDate = new Date(`${endYmd}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) return out;

  const startYear = startDate.getUTCFullYear();
  const endYear = endDate.getUTCFullYear();
  for (let y = startYear; y <= endYear; y++) {
    for (const row of INTERNATIONAL_DAYS) {
      const date = ymd(y, row.m, row.d);
      if (date >= startYmd && date < endYmd) {
        out.push({
          date,
          name: row.name,
          scope: 'worldwide',
          kind: 'observance',
          precision: 'fixed',
          type: 'international',
          source: 'international',
          themes: Array.isArray(row.themes) ? row.themes : [],
          note: row.note || null,
        });
      }
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));
  return out;
}