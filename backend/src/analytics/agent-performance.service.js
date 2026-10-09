import { HttpError } from '../lib/HttpError.js';
import {
  agentDailyBreakdown,
  agentHandledSummary,
  agentMessagesSent,
  agentResponseStats,
  getAnalyticsTimezone,
  listActiveAgents,
} from './agent-performance.repository.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function partsInTimeZone(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day') };
}

function ymd({ year, month, day }) {
  return `${year}-${month}-${day}`;
}

/** Calendar date `days` before today, in the application timezone. */
function daysAgo(timezone, days) {
  const { year, month, day } = partsInTimeZone(timezone);
  const noonUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), 12);
  return ymd(partsInTimeZone(timezone, new Date(noonUtc - days * 86_400_000)));
}

export function todayIn(timezone) {
  return ymd(partsInTimeZone(timezone));
}

function isRealDate(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateDates({ from, to, timezone }) {
  const valid = (value) => Boolean(value) && DATE_PATTERN.test(value) && isRealDate(value);
  if (!valid(from)) throw new HttpError(400, 'Invalid "from" date. Use a real YYYY-MM-DD date.');
  if (!valid(to)) throw new HttpError(400, 'Invalid "to" date. Use a real YYYY-MM-DD date.');
  if (from > to) throw new HttpError(400, '"from" must be on or before "to".');
}

const SORTS = {
  chats: (a, b) => a.chatsHandled - b.chatsHandled,
  messages: (a, b) => a.messagesSent - b.messagesSent,
  customers: (a, b) => a.customers - b.customers,
  // Lower is better: an ascending sort puts the fastest agent first.
  response: (a, b) => (a.averageResponseTimeSeconds ?? Infinity) - (b.averageResponseTimeSeconds ?? Infinity),
  open: (a, b) => a.open - b.open,
  pending: (a, b) => a.pending - b.pending,
  resolved: (a, b) => a.resolved - b.resolved,
  closed: (a, b) => a.closed - b.closed,
};

/**
 * Builds the merged per-agent rows, then applies search + agentId + sort.
 * Aggregation happens in the database (no message/conversation rows ever reach
 * Node); sorting/filtering of the small final row set is done here so average
 * response time can treat "no data" as "not ranked".
 */
async function computeRows({ from, to, timezone, search, agentId, sort, order }) {
  const [agents, handled, sent, responses] = await Promise.all([
    listActiveAgents(),
    agentHandledSummary(from, to, timezone),
    agentMessagesSent(from, to, timezone),
    agentResponseStats(from, to, timezone),
  ]);

  const handledBy = new Map(handled.map((row) => [row.agent_id, row]));
  const sentBy = new Map(sent.map((row) => [row.staff_id, row.messages_sent]));
  const responseBy = new Map(responses.map((row) => [row.agent_id, row]));

  let rows = agents.map((agent) => {
    const h = handledBy.get(agent.id);
    const r = responseBy.get(agent.id);
    const responseSeconds = r && r.response_count > 0 ? Math.round(r.total_seconds / r.response_count) : null;
    return {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      chatsHandled: h?.chats_handled ?? 0,
      customers: h?.customers ?? 0,
      open: h?.open_count ?? 0,
      pending: h?.pending_count ?? 0,
      resolved: h?.resolved_count ?? 0,
      closed: h?.closed_count ?? 0,
      messagesSent: sentBy.get(agent.id) ?? 0,
      responseCount: r?.response_count ?? 0,
      totalResponseSeconds: r?.total_seconds ?? 0,
      averageResponseTimeSeconds: responseSeconds,
    };
  });

  if (agentId !== undefined) {
    rows = rows.filter((row) => row.id === agentId);
  }

  if (search) {
    const needle = search.toLowerCase();
    rows = rows.filter(
      (row) => row.name.toLowerCase().includes(needle) || row.email.toLowerCase().includes(needle)
    );
  }

  if (sort && SORTS[sort]) {
    const direction = order === 'asc' ? 1 : -1;
    rows.sort((a, b) => direction * SORTS[sort](a, b));
  }

  return rows;
}

export async function getAgentPerformance({ from, to, search, agentId, sort = 'chats', order = 'desc' } = {}) {
  const timezone = await getAnalyticsTimezone();

  if (!from) from = daysAgo(timezone, 29);
  if (!to) to = todayIn(timezone);
  validateDates({ from, to, timezone });

  const rows = await computeRows({ from, to, timezone, search, agentId, sort, order });

  const totals = rows.reduce(
    (acc, row) => {
      acc.chatsHandled += row.chatsHandled;
      acc.messagesSent += row.messagesSent;
      acc.customers += row.customers;
      acc.responseCount += row.responseCount;
      acc.totalResponseSeconds += row.totalResponseSeconds;
      return acc;
    },
    { chatsHandled: 0, messagesSent: 0, customers: 0, responseCount: 0, totalResponseSeconds: 0 }
  );

  const agents = rows.map(({ responseCount, totalResponseSeconds, ...row }) => row);

  return {
    period: { from, to, timezone },
    totalAgents: agents.length,
    summary: {
      chatsHandled: totals.chatsHandled,
      messagesSent: totals.messagesSent,
      customers: totals.customers,
      averageResponseTimeSeconds:
        totals.responseCount > 0 ? Math.round(totals.totalResponseSeconds / totals.responseCount) : null,
    },
    agents,
  };
}

export async function getAgentPerformanceDetail(agentId, { from, to } = {}) {
  const timezone = await getAnalyticsTimezone();

  if (!from) from = daysAgo(timezone, 6);
  if (!to) to = todayIn(timezone);
  validateDates({ from, to, timezone });

  const rows = await computeRows({ from, to, timezone, agentId });
  const agent = rows[0];

  if (!agent) {
    throw new HttpError(404, 'Agent not found');
  }

  const daily = await agentDailyBreakdown(agentId, from, to, timezone);

  const { responseCount, totalResponseSeconds, ...publicAgent } = agent;

  return {
    period: { from, to, timezone },
    agent: publicAgent,
    daily,
  };
}