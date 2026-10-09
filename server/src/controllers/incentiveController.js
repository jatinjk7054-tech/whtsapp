import {
  getTargetsByWorker,
  getTarget,
  upsertTarget,
  getCurrentMonthTargets,
  getFROWorkersWithSalary,
} from '../models/incentiveModel.js';
import { getActiveSalaryByWorker } from '../models/salaryModel.js';
import { getWorkerById } from '../models/workerModel.js';
import {
  upsertAchievement,
  deleteAchievement,
  bulkUpsertAchievements,
} from '../models/dailyAchievementModel.js';
import { getDayName, calculateAKI, getMonthsEmployed, getAKISlabs } from '../utils/incentive.js';
import { getMergedDailyAmounts, sumDailyAmounts, sumDailyAKI } from '../utils/dailyAchievementAggregator.js';

function getAutoTarget(salary, monthsEmployed) {
  const multipliers = [1, 2.5, 3];
  const idx = Math.min(Math.max(monthsEmployed - 1, 0), multipliers.length - 1);
  return Math.round(salary * multipliers[idx]);
}

async function getOrCreateTarget(workerId, worker, month) {
  const target = await getTarget(workerId, month);
  if (target) return target;

  const activeSalary = await getActiveSalaryByWorker(workerId);
  if (!activeSalary) return null;

  const [y, m] = month.split('-');
  const monthsEmployed = getMonthsEmployed(worker.created_at, new Date(parseInt(y), parseInt(m), 0));
  const computed = {
    worker_id: workerId,
    month,
    target_amount: getAutoTarget(parseFloat(activeSalary.salary), monthsEmployed),
    is_auto_generated: true,
  };

  try {
    return await upsertTarget(computed);
  } catch (error) {
    console.error('Auto-target persist failed, using computed value:', error.message);
    return computed;
  }
}

function getISTMonthBounds() {
  const offset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(Date.now() + offset);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const startDate = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const endDate = `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { year: y, month: m, startDate, endDate, daysInMonth: lastDay };
}

export const getWorkerTargets = async (req, res) => {
  try {
    const targets = await getTargetsByWorker(req.params.workerId);
    return res.json(targets);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateTarget = async (req, res) => {
  try {
    const { target_amount } = req.body;
    if (target_amount == null || target_amount < 0) {
      return res.status(400).json({ message: 'target_amount is required and must be >= 0' });
    }

    const existing = await getTarget(req.params.workerId, req.params.month);
    const data = {
      worker_id: req.params.workerId,
      month: req.params.month,
      target_amount,
      is_auto_generated: false,
      created_by: req.user.id,
    };

    const result = await upsertTarget(data);
    return res.json({ message: 'Target updated', target: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getCurrentMonthTargetsList = async (req, res) => {
  try {
    const targets = await getCurrentMonthTargets();
    return res.json(targets);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const generateAllTargets = async (req, res) => {
  try {
    const workers = await getFROWorkersWithSalary();
    const month = getISTMonthBounds().startDate;
    const results = [];

    for (const worker of workers) {
      const salary = worker.active_salary?.salary;
      if (!salary) continue;

      const existing = await getTarget(worker.id, month);
      if (existing && !existing.is_auto_generated) {
        results.push({ worker_id: worker.id, name: worker.name, skipped: true, reason: 'manually set' });
        continue;
      }

      const monthsEmployed = getMonthsEmployed(worker.created_at);
      const targetAmount = getAutoTarget(parseFloat(salary), monthsEmployed);

      await upsertTarget({
        worker_id: worker.id,
        month,
        target_amount: targetAmount,
        is_auto_generated: true,
        created_by: req.user.id,
      });

      results.push({ worker_id: worker.id, name: worker.name, target_amount: targetAmount, monthsEmployed });
    }

    return res.json({ message: 'Targets generated', results });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getMyTarget = async (req, res) => {
  try {
    const workerId = req.user.id;
    const month = getISTMonthBounds().startDate;

    let target = await getTarget(workerId, month);
    if (!target) {
      const activeSalary = await getActiveSalaryByWorker(workerId);
      if (!activeSalary) return res.json({ hasTarget: false, message: 'No salary record found' });

      const worker = await getWorkerById(workerId);
      if (!worker || worker.department !== 'FRO') return res.json({ hasTarget: false, message: 'Not an FRO worker' });

      const monthsEmployed = getMonthsEmployed(worker.created_at);
      const targetAmount = getAutoTarget(parseFloat(activeSalary.salary), monthsEmployed);

      target = await upsertTarget({
        worker_id: workerId,
        month,
        target_amount: targetAmount,
        is_auto_generated: true,
      });
    }

    return res.json({ hasTarget: true, target });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getWorkerTargetForMonth = async (req, res) => {
  try {
    const { workerId, month } = req.params;
    const worker = await getWorkerById(workerId);
    const target = worker ? await getOrCreateTarget(workerId, worker, month) : null;
    return res.json(target || { hasTarget: false });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// === DAILY ACHIEVEMENTS ===

export const setAchievement = async (req, res) => {
  try {
    const { workerId, date } = req.params;
    const { amount } = req.body;
    if (amount == null || amount < 0) {
      return res.status(400).json({ message: 'Amount is required and must be >= 0' });
    }
    const record = await upsertAchievement(workerId, date, parseFloat(amount), req.user.id);
    const dayName = getDayName(date);
    const ranges = await getAKISlabs();
    const aki = calculateAKI(parseFloat(amount), dayName, ranges);
    return res.json({ message: 'Achievement saved', record, aki });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getWorkerAchievements = async (req, res) => {
  try {
    const { workerId, month } = req.params;
    const [y, m] = month.split('-');
    const lastDay = new Date(Date.UTC(parseInt(y), parseInt(m), 0)).getUTCDate();
    const startDate = `${y}-${m}-01`;
    const endDate = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
    const withAki = await getMergedDailyAmounts(workerId, startDate, endDate);
    return res.json(withAki);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeAchievement = async (req, res) => {
  try {
    const result = await deleteAchievement(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// === INCENTIVE CALCULATION ===

export const getIncentiveSummary = async (req, res) => {
  try {
    const { workerId, month } = req.params;
    const [y, m] = month.split('-');
    const lastDay = new Date(Date.UTC(parseInt(y), parseInt(m), 0)).getUTCDate();
    const startDate = `${y}-${m}-01`;
    const endDate = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;

    const worker = await getWorkerById(workerId);
    if (!worker) return res.status(404).json({ message: 'Worker not found' });

    const target = await getOrCreateTarget(workerId, worker, startDate);
    if (!target) return res.json({ hasIncentive: false, message: 'No target set for this month' });

    // A manually-entered target can be null/blank. parseFloat() would give NaN,
    // which JSON.stringify sends as null and the client then chokes on. Bail out
    // as "no target" instead: coercing to 0 would make every achievement look
    // target-met and pay out 10% of the whole month's collections.
    const monthlyTarget = Number(target.target_amount);
    if (!Number.isFinite(monthlyTarget) || monthlyTarget <= 0) {
      return res.json({ hasIncentive: false, message: 'No valid target set for this month' });
    }

    const akiPerDay = await getMergedDailyAmounts(workerId, startDate, endDate);
    const monthlyAchievement = sumDailyAmounts(akiPerDay);

    const totalAKI = sumDailyAKI(akiPerDay);

    const monthsEmployed = getMonthsEmployed(worker.created_at);
    const isNewJoiner = monthsEmployed <= 3;
    const monthlyTargetMet = monthlyAchievement >= monthlyTarget;

    let akiPayout = 0;
    let monthlyIncentive = 0;
    let totalIncentive = 0;

    if (monthlyTargetMet) {
      const overage = monthlyAchievement - monthlyTarget;
      monthlyIncentive = Math.round(overage * 0.1);
      akiPayout = isNewJoiner ? totalAKI : Math.round(totalAKI / 2);
      totalIncentive = akiPayout + monthlyIncentive;
    }

    return res.json({
      hasIncentive: true,
      monthlyAchievement,
      monthlyTarget,
      monthlyTargetMet,
      totalAKI,
      akiPerDay,
      akiPayout,
      monthlyIncentive,
      totalIncentive,
      isNewJoiner,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getMonthlySummary = async (req, res) => {
  try {
    const { startDate, endDate } = getISTMonthBounds();
    const workers = await getFROWorkersWithSalary();

    const results = [];
    for (const worker of workers) {
      const target = await getTarget(worker.id, startDate);
      if (!target) continue;

      // Same guard as getIncentiveSummary: a null/blank target must not become
      // NaN (sent as null) and must not count as a met target of zero.
      const monthlyTarget = Number(target.target_amount);
      if (!Number.isFinite(monthlyTarget) || monthlyTarget <= 0) continue;

      const daily = await getMergedDailyAmounts(worker.id, startDate, endDate);
      const monthlyAchievement = sumDailyAmounts(daily);

      const totalAKI = sumDailyAKI(daily);

      const monthsEmployed = getMonthsEmployed(worker.created_at);
      const isNewJoiner = monthsEmployed <= 3;
      const monthlyTargetMet = monthlyAchievement >= monthlyTarget;

      let akiPayout = 0;
      let monthlyIncentive = 0;
      let totalIncentive = 0;

      if (monthlyTargetMet) {
        const overage = monthlyAchievement - monthlyTarget;
        monthlyIncentive = Math.round(overage * 0.1);
        akiPayout = isNewJoiner ? totalAKI : Math.round(totalAKI / 2);
        totalIncentive = akiPayout + monthlyIncentive;
      }

      results.push({
        worker_id: worker.id,
        name: worker.name,
        monthlyAchievement,
        monthlyTarget,
        monthlyTargetMet,
        totalAKI,
        akiPayout,
        monthlyIncentive,
        totalIncentive,
        isNewJoiner,
      });
    }

    return res.json(results);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const bulkSetAchievements = async (req, res) => {
  try {
    const { entries } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ message: 'entries array is required' });
    }
    const enriched = entries.map(e => ({
      worker_id: e.worker_id,
      date: e.date,
      amount: parseFloat(e.amount || 0),
      created_by: req.user.id,
    }));
    const results = await bulkUpsertAchievements(enriched);
    return res.json({ message: 'Achievements saved', count: results.length });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
