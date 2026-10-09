import { getAKISlabs, persistAKISlabs, DAY_NAMES, AKI_RANGES } from '../utils/incentive.js';
import { getSetting, upsertSetting } from '../models/settingsModel.js';

const RULES_KEY = 'incentive_rules';

export const DEFAULT_RULES = {
  monthlyIncentivePercent: 10,
  akiPayoutExistingPercent: 50,
  akiPayoutNewJoinerPercent: 100,
  newJoinerMonths: 3,
  targetMultipliers: [1, 2.5, 3],
};

export async function getIncentiveRules() {
  const stored = await getSetting(RULES_KEY);
  if (!stored) return { ...DEFAULT_RULES };
  try {
    const parsed = JSON.parse(stored) || {};
    return {
      monthlyIncentivePercent: Number.isFinite(Number(parsed.monthlyIncentivePercent)) ? Number(parsed.monthlyIncentivePercent) : DEFAULT_RULES.monthlyIncentivePercent,
      akiPayoutExistingPercent: Number.isFinite(Number(parsed.akiPayoutExistingPercent)) ? Number(parsed.akiPayoutExistingPercent) : DEFAULT_RULES.akiPayoutExistingPercent,
      akiPayoutNewJoinerPercent: Number.isFinite(Number(parsed.akiPayoutNewJoinerPercent)) ? Number(parsed.akiPayoutNewJoinerPercent) : DEFAULT_RULES.akiPayoutNewJoinerPercent,
      newJoinerMonths: Number.isFinite(Number(parsed.newJoinerMonths)) ? Number(parsed.newJoinerMonths) : DEFAULT_RULES.newJoinerMonths,
      targetMultipliers: Array.isArray(parsed.targetMultipliers) && parsed.targetMultipliers.length
        ? parsed.targetMultipliers.map(Number).filter(Number.isFinite)
        : DEFAULT_RULES.targetMultipliers,
    };
  } catch {
    return { ...DEFAULT_RULES };
  }
}

export const getAkiConfig = async (req, res) => {
  try {
    const slabs = await getAKISlabs();
    // FROs/workers only need the slabs for the banner; rules are internal admin config.
    if (req.user && req.user.role && req.user.role !== 'accounts' && req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'hr') {
      return res.json({ slabs, days: DAY_NAMES });
    }
    const rules = await getIncentiveRules();
    return res.json({ slabs, rules, days: DAY_NAMES });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const putAkiSlabs = async (req, res) => {
  try {
    const { slabs } = req.body || {};
    if (!slabs || typeof slabs !== 'object') {
      return res.status(400).json({ message: 'slabs object is required' });
    }
    const saved = await persistAKISlabs(slabs);
    return res.json({ slabs: saved });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const putIncentiveRules = async (req, res) => {
  try {
    const body = req.body || {};
    const rules = {
      monthlyIncentivePercent: Number(body.monthlyIncentivePercent),
      akiPayoutExistingPercent: Number(body.akiPayoutExistingPercent),
      akiPayoutNewJoinerPercent: Number(body.akiPayoutNewJoinerPercent),
      newJoinerMonths: Number(body.newJoinerMonths),
      targetMultipliers: Array.isArray(body.targetMultipliers)
        ? body.targetMultipliers.map(Number).filter(Number.isFinite)
        : (await getIncentiveRules()).targetMultipliers,
    };
    if (![rules.monthlyIncentivePercent, rules.akiPayoutExistingPercent, rules.akiPayoutNewJoinerPercent, rules.newJoinerMonths].every(Number.isFinite)) {
      return res.status(400).json({ message: 'Invalid incentive rule values' });
    }
    await upsertSetting(RULES_KEY, JSON.stringify(rules));
    return res.json({ rules });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const resetAkiConfig = async (req, res) => {
  try {
    await upsertSetting(RULES_KEY, JSON.stringify(DEFAULT_RULES));
    const slabs = {};
    for (const day of DAY_NAMES) slabs[day] = AKI_RANGES[day];
    await persistAKISlabs(slabs);
    return res.json({ slabs, rules: DEFAULT_RULES });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
