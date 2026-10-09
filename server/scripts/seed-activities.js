import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SECTOR_NAME_MAP = {
  'Education & Learning': 'Education & Learning',
  'Livelihood, Skill & Employment Aatmanirbhar': 'Livelihood, Skill & Employment Aatmanirbhar',
  'Livelihood, Skill & Employment Aatmanirbhar Sector': 'Livelihood, Skill & Employment Aatmanirbhar',
  'Technology & Assistive Devices': 'Technology & Assistive Devices',
  'Independent Living & Mobility': 'Independent Living & Mobility',
  'Health, Rehabilitation & Wellness': 'Health, Rehabilitation & Wellness',
  'Sports, Culture & Talent': 'Sports, Culture & Talent',
  'Women & Children with Disabilities': 'Women & Children with Disabilities',
  'Rights, Government Schemes & Accessibility': 'Rights, Government Schemes & Accessibility',
  'Products, Entrepreneurship & E-commerce': 'Products, Entrepreneurship & E-commerce',
  'Social Inclusion & Community': 'Social Inclusion & Community',
  'Environment': 'Environment',
  'Environment Sector': 'Environment',
  'Nutrition': 'Nutrition',
  'Nutrition Sector': 'Nutrition',
  'LIVELIHOOD & SKILL DEVELOPMENT': 'Livelihood, Skill & Employment Aatmanirbhar',
  'ASSISTIVE DEVICES': 'Technology & Assistive Devices',
  'HEALTH & WELFARE': 'Health, Rehabilitation & Wellness',
  'COMMUNITY INCLUSION': 'Social Inclusion & Community',
  'ENVIRONMENT': 'Environment',
};

const RAW_ACTIVITIES = [
  { sector: 'Education & Learning', name: 'Braille education' },
  { sector: 'Education & Learning', name: 'School support' },
  { sector: 'Education & Learning', name: 'Scholarships' },
  { sector: 'Education & Learning', name: 'Digital literacy' },
  { sector: 'Education & Learning', name: 'Computer training' },
  { sector: 'Education & Learning', name: 'Smartphone training' },
  { sector: 'Education & Learning', name: 'English & communication skills' },
  { sector: 'Education & Learning', name: 'Competitive exam preparation' },
  { sector: 'Education & Learning', name: 'Career counselling' },
  { sector: 'Education & Learning', name: 'College/university support' },
  { sector: 'Education & Learning', name: 'Accessible study material' },
  { sector: 'Education & Learning', name: 'Audio books & e-learning' },
  { sector: 'Education & Learning', name: 'Library for visually impaired' },
  { sector: 'Education & Learning', name: 'Teacher & parent awareness programs' },
  { sector: 'Education & Learning', name: 'Braille Book Distribution' },
  { sector: 'Education & Learning', name: 'Digital Education Centre' },
  { sector: 'Education & Learning', name: 'Computer Education with Screen Readers' },
  { sector: 'Education & Learning', name: 'AI & Smart Assistive Technology Training' },
  { sector: 'Education & Learning', name: 'Spoken English Classes' },
  { sector: 'Education & Learning', name: 'Competitive Exam Coaching' },
  { sector: 'Education & Learning', name: 'Digital Skill Development' },
  { sector: 'Education & Learning', name: 'Library & Audio Book Centre' },
  { sector: 'Education & Learning', name: 'Scholarship & Education Fee Support' },
  { sector: 'Education & Learning', name: 'School Bag & Stationery Distribution for Blind Students' },

  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Vocational training' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Job placement' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Corporate employment' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Work-from-home opportunities' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Self-employment' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Entrepreneurship training' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Small-business support' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Micro-business funding' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Tool/equipment assistance' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Digital freelancing' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Telecalling training' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Massage/wellness training' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Handicraft/product-making' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'E-commerce selling' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Resume & interview training' },
  { sector: 'Livelihood, Skill & Employment Aatmanirbhar', name: 'Employer sensitisation' },
  { sector: 'LIVELIHOOD & SKILL DEVELOPMENT', name: 'Sewing Machine Distribution' },
  { sector: 'LIVELIHOOD & SKILL DEVELOPMENT', name: 'Flour Mill Distribution' },
  { sector: 'LIVELIHOOD & SKILL DEVELOPMENT', name: 'Rozgaar Booth' },
  { sector: 'LIVELIHOOD & SKILL DEVELOPMENT', name: 'Vocational Training' },
  { sector: 'LIVELIHOOD & SKILL DEVELOPMENT', name: 'Digital Employment Support' },
  { sector: 'LIVELIHOOD & SKILL DEVELOPMENT', name: 'Interview Preparation Sessions' },
  { sector: 'LIVELIHOOD & SKILL DEVELOPMENT', name: 'Entrepreneurship Training' },

  { sector: 'Technology & Assistive Devices', name: 'AI mobility solutions' },
  { sector: 'Technology & Assistive Devices', name: 'Smart walking/assistive devices' },
  { sector: 'Technology & Assistive Devices', name: 'Screen readers' },
  { sector: 'Technology & Assistive Devices', name: 'Smartphones' },
  { sector: 'Technology & Assistive Devices', name: 'Accessible apps' },
  { sector: 'Technology & Assistive Devices', name: 'Computer accessibility' },
  { sector: 'Technology & Assistive Devices', name: 'Assistive software' },
  { sector: 'Technology & Assistive Devices', name: 'Digital navigation' },
  { sector: 'Technology & Assistive Devices', name: 'Voice-based technology' },
  { sector: 'Technology & Assistive Devices', name: 'Accessible websites' },
  { sector: 'Technology & Assistive Devices', name: 'Device training' },
  { sector: 'Technology & Assistive Devices', name: 'Assistive-device repair/support' },
  { sector: 'Technology & Assistive Devices', name: 'Technology innovation lab' },
  { sector: 'ASSISTIVE DEVICES', name: 'White Cane Distribution' },
  { sector: 'ASSISTIVE DEVICES', name: 'Smart Glass Distribution' },
  { sector: 'ASSISTIVE DEVICES', name: 'Talking Devices' },
  { sector: 'ASSISTIVE DEVICES', name: 'Accessible Mobile Phones' },
  { sector: 'ASSISTIVE DEVICES', name: 'Braille Slates & Learning Kits' },

  { sector: 'Independent Living & Mobility', name: 'Mobility training' },
  { sector: 'Independent Living & Mobility', name: 'Orientation & mobility' },
  { sector: 'Independent Living & Mobility', name: 'Independent cooking' },
  { sector: 'Independent Living & Mobility', name: 'Household skills' },
  { sector: 'Independent Living & Mobility', name: 'Money-management skills' },
  { sector: 'Independent Living & Mobility', name: 'Personal safety' },
  { sector: 'Independent Living & Mobility', name: 'Public transport training' },
  { sector: 'Independent Living & Mobility', name: 'Travel training' },
  { sector: 'Independent Living & Mobility', name: 'Accessible housing awareness' },
  { sector: 'Independent Living & Mobility', name: 'Independent-living centres' },
  { sector: 'Independent Living & Mobility', name: 'Mobility equipment' },
  { sector: 'Independent Living & Mobility', name: 'Community-based rehabilitation' },

  { sector: 'Health, Rehabilitation & Wellness', name: 'Eye check-up camps' },
  { sector: 'Health, Rehabilitation & Wellness', name: 'General health camps' },
  { sector: 'Health, Rehabilitation & Wellness', name: 'Physiotherapy' },
  { sector: 'Health, Rehabilitation & Wellness', name: 'Rehabilitation' },
  { sector: 'Health, Rehabilitation & Wellness', name: 'Occupational therapy' },
  { sector: 'Health, Rehabilitation & Wellness', name: 'Speech therapy' },
  { sector: 'Health, Rehabilitation & Wellness', name: 'Preventive healthcare' },
  { sector: 'Health, Rehabilitation & Wellness', name: 'Nutrition awareness' },
  { sector: 'Health, Rehabilitation & Wellness', name: 'Mental-wellbeing support' },
  { sector: 'Health, Rehabilitation & Wellness', name: 'Health insurance awareness' },
  { sector: 'Health, Rehabilitation & Wellness', name: 'Medical assistance' },
  { sector: 'Health, Rehabilitation & Wellness', name: 'Assistive-device assessment' },
  { sector: 'Health, Rehabilitation & Wellness', name: 'Hospital referral network' },
  { sector: 'HEALTH & WELFARE', name: 'Medical Emergency Support' },
  { sector: 'HEALTH & WELFARE', name: 'Eye Care & Rehabilitation' },
  { sector: 'HEALTH & WELFARE', name: 'Nutrition Support' },
  { sector: 'HEALTH & WELFARE', name: 'Ration Kits' },
  { sector: 'HEALTH & WELFARE', name: 'Annapurna Food Distribution' },
  { sector: 'HEALTH & WELFARE', name: 'Seasonal Relief Kits' },

  { sector: 'Sports, Culture & Talent', name: 'Blind cricket' },
  { sector: 'Sports, Culture & Talent', name: 'Football' },
  { sector: 'Sports, Culture & Talent', name: 'Athletics' },
  { sector: 'Sports, Culture & Talent', name: 'Chess' },
  { sector: 'Sports, Culture & Talent', name: 'Swimming' },
  { sector: 'Sports, Culture & Talent', name: 'Yoga' },
  { sector: 'Sports, Culture & Talent', name: 'Adaptive sports' },
  { sector: 'Sports, Culture & Talent', name: 'Music' },
  { sector: 'Sports, Culture & Talent', name: 'Singing' },
  { sector: 'Sports, Culture & Talent', name: 'Dance' },
  { sector: 'Sports, Culture & Talent', name: 'Art' },
  { sector: 'Sports, Culture & Talent', name: 'Public speaking' },
  { sector: 'Sports, Culture & Talent', name: 'Theatre' },
  { sector: 'Sports, Culture & Talent', name: 'Talent competitions' },
  { sector: 'Sports, Culture & Talent', name: 'National/state tournaments' },
  { sector: 'Sports, Culture & Talent', name: 'Sports equipment' },
  { sector: 'Sports, Culture & Talent', name: 'Athlete sponsorship' },

  { sector: 'Women & Children with Disabilities', name: 'Early intervention' },
  { sector: 'Women & Children with Disabilities', name: 'Special education support' },
  { sector: 'Women & Children with Disabilities', name: 'School inclusion' },
  { sector: 'Women & Children with Disabilities', name: 'Scholarships' },
  { sector: 'Women & Children with Disabilities', name: 'Parent counselling' },
  { sector: 'Women & Children with Disabilities', name: 'Skill development' },
  { sector: 'Women & Children with Disabilities', name: 'Accessible toys/learning tools' },
  { sector: 'Women & Children with Disabilities', name: 'Talent development' },
  { sector: 'Women & Children with Disabilities', name: 'Self-defence' },
  { sector: 'Women & Children with Disabilities', name: 'Women employment' },
  { sector: 'Women & Children with Disabilities', name: 'Entrepreneurship' },
  { sector: 'Women & Children with Disabilities', name: 'Menstrual hygiene' },
  { sector: 'Women & Children with Disabilities', name: 'Financial literacy' },
  { sector: 'Women & Children with Disabilities', name: 'Leadership development' },
  { sector: 'Women & Children with Disabilities', name: 'Safety & awareness' },
  { sector: 'Women & Children with Disabilities', name: 'Women-led businesses' },

  { sector: 'Rights, Government Schemes & Accessibility', name: 'Disability certificate assistance' },
  { sector: 'Rights, Government Schemes & Accessibility', name: 'UDID assistance' },
  { sector: 'Rights, Government Schemes & Accessibility', name: 'Government scheme awareness' },
  { sector: 'Rights, Government Schemes & Accessibility', name: 'Pension/scholarship assistance' },
  { sector: 'Rights, Government Schemes & Accessibility', name: 'Legal awareness' },
  { sector: 'Rights, Government Schemes & Accessibility', name: 'Rights awareness' },
  { sector: 'Rights, Government Schemes & Accessibility', name: 'Employment-rights awareness' },
  { sector: 'Rights, Government Schemes & Accessibility', name: 'Accessible voting awareness' },
  { sector: 'Rights, Government Schemes & Accessibility', name: 'Accessible transportation' },
  { sector: 'Rights, Government Schemes & Accessibility', name: 'Accessible public buildings' },
  { sector: 'Rights, Government Schemes & Accessibility', name: 'Accessibility audits' },
  { sector: 'Rights, Government Schemes & Accessibility', name: 'Corporate accessibility consulting' },
  { sector: 'Rights, Government Schemes & Accessibility', name: 'Disability inclusion awareness' },

  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Identify products made by disabled individuals' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Product development' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Packaging' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Branding' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Product photography' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Visiting cards' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Brochures' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Digital catalogues' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'E-commerce onboarding' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Online marketplace' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Corporate gifting' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Exhibitions' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Local market linkage' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Corporate sales' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Order management' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Financial literacy' },
  { sector: 'Products, Entrepreneurship & E-commerce', name: 'Made by Ability brand' },

  { sector: 'Social Inclusion & Community', name: 'Inclusive events' },
  { sector: 'Social Inclusion & Community', name: 'Community awareness' },
  { sector: 'Social Inclusion & Community', name: 'Volunteer programs' },
  { sector: 'Social Inclusion & Community', name: 'Disability sensitisation' },
  { sector: 'Social Inclusion & Community', name: 'Corporate inclusion programs' },
  { sector: 'Social Inclusion & Community', name: 'School awareness' },
  { sector: 'Social Inclusion & Community', name: 'College volunteer programs' },
  { sector: 'Social Inclusion & Community', name: 'Accessible events' },
  { sector: 'Social Inclusion & Community', name: 'Family support' },
  { sector: 'Social Inclusion & Community', name: 'Peer-support groups' },
  { sector: 'Social Inclusion & Community', name: 'Community centres' },
  { sector: 'Social Inclusion & Community', name: 'Social gatherings' },
  { sector: 'Social Inclusion & Community', name: 'Cultural programs' },
  { sector: 'Social Inclusion & Community', name: 'Public awareness campaigns' },
  { sector: 'COMMUNITY INCLUSION', name: 'Metro Saheli' },
  { sector: 'COMMUNITY INCLUSION', name: 'Volunteer Reading Programme' },
  { sector: 'COMMUNITY INCLUSION', name: 'Awareness Programmes' },
  { sector: 'COMMUNITY INCLUSION', name: 'Disability Rights Campaigns' },

  { sector: 'Environment', name: 'Bottle Crusher Machines' },
  { sector: 'Environment', name: 'Plantation Drives' },
  { sector: 'Environment', name: 'Animal Feeding' },
  { sector: 'Environment', name: 'Rainwater Harvesting Projects' },
  { sector: 'ENVIRONMENT', name: 'Bottle Crusher Machines' },
  { sector: 'ENVIRONMENT', name: 'Plantation Drives' },
  { sector: 'ENVIRONMENT', name: 'Animal Feeding' },
  { sector: 'ENVIRONMENT', name: 'Rainwater Harvesting Projects' },
];

const NGO_CODES = ['BSCT', 'MANN', 'AFLF'];

// Branded campaign / event names (from the same sheet) are NOT master
// activities — the "No. of Activities" counts reference only the generic
// activity catalog, so these are skipped during activity seeding.
const CAMPAIGN_SECTORS = new Set([
  'LIVELIHOOD & SKILL DEVELOPMENT',
  'ASSISTIVE DEVICES',
  'HEALTH & WELFARE',
  'COMMUNITY INCLUSION',
  'ENVIRONMENT',
]);
const CAMPAIGN_NAMES = new Set([
  'Braille Book Distribution',
  'Digital Education Centre',
  'Computer Education with Screen Readers',
  'AI & Smart Assistive Technology Training',
  'Spoken English Classes',
  'Competitive Exam Coaching',
  'Digital Skill Development',
  'Library & Audio Book Centre',
  'Scholarship & Education Fee Support',
  'School Bag & Stationery Distribution for Blind Students',
]);

function normalizeName(name) {
  return name.trim().replace(/\s+/g, ' ');
}

function deduplicate(activities) {
  const seen = new Set();
  const result = [];
  for (const a of activities) {
    const key = a.sector + '\u0000' + a.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(a);
    }
  }
  return result;
}

async function main() {
  const client = await pool.connect();
  try {
    console.log('Fetching sectors...');
    const sectorsResult = await client.query('SELECT id, name FROM event_head_sectors WHERE is_active = TRUE ORDER BY sort_order');
    const sectorByName = {};
    for (const row of sectorsResult.rows) {
      sectorByName[row.name] = row.id;
    }
    console.log('Sectors found:', Object.keys(sectorByName));

    console.log('Fetching NGOs...');
    const ngosResult = await client.query("SELECT id, UPPER(COALESCE(code, name)) AS code, name FROM ngos WHERE UPPER(COALESCE(code, name)) IN ('BSCT','MANN','AFLF')");
    const ngoByCode = {};
    for (const row of ngosResult.rows) {
      ngoByCode[row.code] = row.id;
    }
    console.log('NGOs found:', Object.keys(ngoByCode));

    if (Object.keys(ngoByCode).length === 0) {
      console.error('No NGOs found with codes BSCT, MANN, AFLF. Seed ngos first.');
      return;
    }

    // Normalize any sheet label to the DB sector name (fuzzy, order-agnostic).
    const normKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const normSectors = Object.keys(sectorByName).map(n => [n, normKey(n)]);

    const canonicalize = (label) => {
      if (SECTOR_NAME_MAP[label]) return SECTOR_NAME_MAP[label];
      if (sectorByName[label]) return label;
      const lbl = label.replace(/\s+Sector$/i, '');
      if (SECTOR_NAME_MAP[lbl] || sectorByName[lbl]) return SECTOR_NAME_MAP[lbl] || lbl;
      const key = normKey(lbl);
      const hit = normSectors.find(([, k]) => k === key);
      if (hit) return hit[0];
      if (key.includes('livelihood') || key.includes('aatmanirbhar')) return 'Livelihood, Skill & Employment Aatmanirbhar';
      if (key.includes('education')) return 'Education & Learning';
      if (key.includes('technology') || key.includes('assistive') || key.includes('device')) return 'Technology & Assistive Devices';
      if (key.includes('independent')) return 'Independent Living & Mobility';
      if (key.includes('health') || key.includes('rehabilitation') || key.includes('wellness')) return 'Health, Rehabilitation & Wellness';
      if (key.includes('sport') || key.includes('culture') || key.includes('talent')) return 'Sports, Culture & Talent';
      if (key.includes('women') || key.includes('child') || key.includes('children')) return 'Women & Children with Disabilities';
      if (key.includes('right') || key.includes('government') || key.includes('accessib')) return 'Rights, Government Schemes & Accessibility';
      if (key.includes('product') || key.includes('entrepreneurship') || key.includes('ecommerce') || key.includes('e-commerce')) return 'Products, Entrepreneurship & E-commerce';
      if (key.includes('social') || key.includes('inclusion') || key.includes('community')) return 'Social Inclusion & Community';
      if (key.includes('environment')) return 'Environment';
      if (key.includes('nutrition') || key.includes('food')) return 'Nutrition';
      return label;
    };

    const activitiesBySector = {};
    let campaignSkip = 0;
    for (const raw of RAW_ACTIVITIES) {
      const name = normalizeName(raw.name);
      const isCampaign = CAMPAIGN_SECTORS.has(raw.sector) || CAMPAIGN_NAMES.has(name);
      if (isCampaign) { campaignSkip++; continue; }
      const canonicalSector = canonicalize(raw.sector);
      if (!activitiesBySector[canonicalSector]) activitiesBySector[canonicalSector] = [];
      activitiesBySector[canonicalSector].push({ name, sector: canonicalSector });
    }

    for (const sectorName of Object.keys(activitiesBySector)) {
      activitiesBySector[sectorName] = deduplicate(activitiesBySector[sectorName]);
    }

    console.log('Activities per sector (should match the No. of Activities table):');
    for (const [sectorName, activities] of Object.entries(activitiesBySector).sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${sectorName}: ${activities.length}`);
    }
    console.log(`Skipped ${campaignSkip} campaign/event names (not master activities).`);

    let totalInserted = 0;
    for (const ngoCode of NGO_CODES) {
      const ngoId = ngoByCode[ngoCode];
      if (!ngoId) continue;

      for (const [sectorName, activities] of Object.entries(activitiesBySector)) {
        const sectorId = sectorByName[sectorName];
        if (!sectorId) {
          console.warn(`Sector not found in DB: ${sectorName}`);
          continue;
        }

        for (const activity of activities) {
          try {
            await client.query(
              `INSERT INTO event_head_activities (ngo_id, sector_id, name, description, status, created_by)
               VALUES ($1, $2, $3, $4, 'Active', 'seed-script')
               ON CONFLICT (ngo_id, sector_id, name) DO NOTHING`,
              [ngoId, sectorId, activity.name, `Auto-seeded for ${ngoCode}`]
            );
            totalInserted++;
          } catch (e) {
            console.error(`Failed to insert activity ${activity.name} for ${ngoCode}/${sectorName}:`, e.message);
          }
        }
      }
      console.log(`Seeded activities for ${ngoCode}`);
    }

    console.log(`\nDone. Total activities inserted (or skipped if existed): ${totalInserted}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });