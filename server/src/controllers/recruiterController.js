import { getUserById } from '../models/userModel.js';
import { getRecruiterWorkers } from '../models/workerModel.js';
import { getAllLeads } from '../models/leadModel.js';
import { leadBelongsTo, countConverted, countRejected, conversionRate } from '../utils/leads.js';
import { istParts, istDateString, istMonthBounds } from '../utils/ist.js';
import db from '../config/db.js';

export const listRecruiters = async (req, res) => {
  try {
    const recruiters = await getRecruiterWorkers();

    const leads = await getAllLeads();
      const withStats = recruiters.map((r) => {
        const recruiterLeads = leads.filter((l) => leadBelongsTo(l, r));
        const total = recruiterLeads.length;
        const scheduled = recruiterLeads.filter((l) => l.status === 'scheduled').length;
        return { ...r, leadsCount: total, scheduled };
      });

    return res.json(withStats);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getRecruiterStats = async (req, res) => {
  try {
    const recruiter = await getRecruiterWorkers();
    const thisRecruiter = recruiter.find((r) => String(r.id) === String(req.params.id));
    if (!thisRecruiter) return res.status(404).json({ message: 'Recruiter not found' });

    // Fetched unfiltered and matched in JS so name-only leads count here too. An
    // id-only `.or()` in SQL drops every row that never stored recruiter_id or
    // created_by, which is what left the leaderboard empty for real recruiters.
    const leads = (await getAllLeads()).filter((l) => leadBelongsTo(l, thisRecruiter));
    const total = leads.length;
    const byStatus = {};
    leads.forEach((l) => {
      byStatus[l.status] = (byStatus[l.status] || 0) + 1;
    });
    const joined = countConverted(leads);
    const rejected = countRejected(leads);

    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = istDateString(d);
      last7.push({
        date: ds,
        count: leads.filter((l) => istDateString(l.created_at ? new Date(l.created_at) : null) === ds).length,
      });
    }

    return res.json({
      recruiter: thisRecruiter,
      stats: { total, byStatus, conversionRate: conversionRate(leads), joined, rejected, last7 },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getRecruiterOverview = async (req, res) => {
  try {
    const recruiters = await getRecruiterWorkers();
    const allLeads = await getAllLeads();

    const today = istDateString();
    const now = new Date();

    const recruiterStats = recruiters.map((r) => {
      const rLeads = allLeads.filter((l) => leadBelongsTo(l, r));
      const total = rLeads.length;
      const byStatus = {};
      rLeads.forEach((l) => { byStatus[l.status] = (byStatus[l.status] || 0) + 1; });

      const scheduled = byStatus['scheduled'] || 0;
      const pending = (byStatus['hold'] || 0) + (byStatus['followed_up'] || 0) + (byStatus['call_back'] || 0) + (byStatus['ringing'] || 0) + (byStatus['unreachable'] || 0) + (byStatus['busy'] || 0) + (byStatus['switched_off'] || 0);
      // `selected` is the recruiter UI's label for "cleared the first round", so
      // it is the interview stage here; `joined` counts every converted status.
      const interviewed = byStatus['selected'] || 0;
      const joined = countConverted(rLeads);
      const rejected = countRejected(rLeads);
      const followUp = (byStatus['followed_up'] || 0) + (byStatus['call_back'] || 0);

      const convBase = joined + rejected;
      const convRate = convBase > 0 ? parseFloat(((joined / convBase) * 100).toFixed(1)) : 0;

      const todayLeads = rLeads.filter((l) => istDateString(l.created_at ? new Date(l.created_at) : null) === today).length;

      const recentActivity = rLeads
        .filter((l) => l.updated_at)
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];

      const lastActivity = recentActivity?.updated_at || recentActivity?.created_at || null;

      const avgResponseTime = calculateAvgResponseTime(rLeads);

      return {
        id: r.id,
        name: r.name,
        department: r.department,
        leadsCount: total,
        scheduled,
        pending,
        interviewed,
        joined,
        rejected,
        followUp,
        conversionRate: convRate,
        todayLeads,
        lastActivity,
        avgResponseTime,
        byStatus,
      };
    });

    const totalRecruiters = recruiters.length;
    const totalLeads = allLeads.length;
    const totalScheduled = allLeads.filter((l) => l.status === 'scheduled').length;
    const totalPending = allLeads.filter((l) => ['hold', 'followed_up', 'call_back', 'ringing', 'unreachable', 'busy', 'switched_off'].includes(l.status)).length;
    const totalInterviewed = allLeads.filter((l) => l.status === 'selected').length;
    const totalJoined = countConverted(allLeads);
    const totalRejected = countRejected(allLeads);
    const totalFollowUp = allLeads.filter((l) => ['followed_up', 'call_back'].includes(l.status)).length;
    const overallConversionRate = conversionRate(allLeads);

    const statusBreakdown = {};
    allLeads.forEach((l) => {
      const s = l.status || 'unknown';
      statusBreakdown[s] = (statusBreakdown[s] || 0) + 1;
    });

    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const ds = istDateString(d);
      const dayLabel = d.toLocaleDateString('en', { weekday: 'short' });
      last7Days.push({
        date: ds,
        label: dayLabel,
        count: allLeads.filter((l) => istDateString(l.created_at ? new Date(l.created_at) : null) === ds).length,
      });
    }

    const monthlyData = [];
    // Day-of-month math on `new Date(y, m, 1)` overflows when the current day is
    // the 29th-31st, and its local midnight shifts across the IST month when the
    // server runs on UTC. Anchor on the 1st of each month inside IST.
    const nowIst = istParts();
    for (let i = 5; i >= 0; i--) {
      const anchor = new Date(Date.UTC(nowIst.year, nowIst.month - 1 - i, 1, 12));
      const monthLabel = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'Asia/Kolkata' }).format(anchor);
      const { start, end } = istMonthBounds(anchor);
      const monthLeads = allLeads.filter((l) => {
        if (!l.created_at) return false;
        const t = new Date(l.created_at).getTime();
        return t >= start.getTime() && t <= end.getTime();
      });
      monthlyData.push({
        month: monthLabel,
        total: monthLeads.length,
        scheduled: monthLeads.filter((l) => l.status === 'scheduled').length,
        joined: countConverted(monthLeads),
        rejected: countRejected(monthLeads),
      });
    }

    const todayActivities = allLeads
      .filter((l) => {
        const t = l.updated_at || l.created_at;
        return t && istDateString(new Date(t)) === today;
      })
      .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))
      .slice(0, 20)
      .map((l) => ({
        id: l.id,
        name: l.name,
        status: l.status,
        recruiter: l.created_by_name || 'System',
        time: l.updated_at || l.created_at,
      }));

    const activeRecruiters = recruiterStats.filter((r) => r.leadsCount > 0).length;
    const avgLeadsPerRecruiter = totalRecruiters > 0 ? parseFloat((totalLeads / totalRecruiters).toFixed(1)) : 0;

    const totalLeadAge = allLeads.reduce((sum, l) => {
      const created = new Date(l.created_at);
      const diffDays = (now - created) / (1000 * 60 * 60 * 24);
      return sum + diffDays;
    }, 0);
    const avgHiringTime = totalLeads > 0 ? parseFloat((totalLeadAge / totalLeads).toFixed(1)) : 0;

    return {
      summary: {
        totalRecruiters,
        activeRecruiters,
        totalLeads,
        totalScheduled,
        totalPending,
        totalInterviewed,
        totalJoined,
        totalRejected,
        totalFollowUp,
        overallConversionRate,
      },
      recruiterStats,
      statusBreakdown,
      last7Days,
      monthlyData,
      todayActivities,
      analytics: {
        avgLeadsPerRecruiter,
        avgHiringTime,
        avgResponseTime: calculateAvgResponseTime(allLeads),
        avgDailyLeads: last7Days.length > 0 ? parseFloat((totalLeads / 30).toFixed(1)) : 0,
      },
    };
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

function calculateAvgResponseTime(leads) {
  const withUpdates = leads.filter((l) => l.created_at && l.updated_at && l.created_at !== l.updated_at);
  if (withUpdates.length === 0) return 0;
  const totalHours = withUpdates.reduce((sum, l) => {
    const created = new Date(l.created_at);
    const updated = new Date(l.updated_at);
    const diffMs = updated - created;
    return sum + diffMs / (1000 * 60 * 60);
  }, 0);
  return parseFloat((totalHours / withUpdates.length).toFixed(1));
}
