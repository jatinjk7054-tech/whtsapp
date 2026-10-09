import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { formatDuration } from '../lib/format.js';
import ErrorBanner from './ErrorBanner.jsx';

/**
 * Module 8 — Agent Performance. Every figure comes from the analytics
 * endpoints, which aggregate real conversations and messages in PostgreSQL (no
 * N+1, no sample data, nothing generated client-side), and every endpoint is
 * Admin-only — the backend rejects agents with 403 even if this dialog were
 * opened by hand. "Today", "yesterday", "this month" etc. are computed in the
 * application timezone carried by the away-message settings (fallback
 * Asia/Kolkata) so the page agrees with the inbox on what a day is.
 */

const EMPTY_STATE = 'No performance data available for this period.';

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'custom', label: 'Custom range' },
];

const COLUMNS = [
  { key: 'name', label: 'Agent', sortable: false },
  { key: 'chats', label: 'Chats', sortable: true },
  { key: 'messages', label: 'Messages', sortable: true },
  { key: 'customers', label: 'Customers', sortable: true },
  { key: 'response', label: 'Avg response', sortable: true },
  { key: 'open', label: 'Open', sortable: true },
  { key: 'pending', label: 'Pending', sortable: true },
  { key: 'resolved', label: 'Resolved', sortable: true },
  { key: 'closed', label: 'Closed', sortable: true },
];

const DEFAULT_SORT = 'chats';
const DEFAULT_ORDER = 'desc';

function partsInTimeZone(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day') };
}

const ymd = ({ year, month, day }) => `${year}-${month}-${day}`;

function todayIn(timezone) {
  return ymd(partsInTimeZone(timezone));
}

function daysAgo(timezone, days) {
  const { year, month, day } = partsInTimeZone(timezone);
  const atNoonUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), 12);
  return ymd(partsInTimeZone(timezone, new Date(atNoonUtc - days * 86_400_000)));
}

function monthStart(timezone) {
  const { year, month } = partsInTimeZone(timezone);
  return `${year}-${month}-01`;
}

function resolveRange(preset, timezone, customFrom, customTo) {
  const today = todayIn(timezone);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: daysAgo(timezone, 1), to: daysAgo(timezone, 1) };
    case 'last7':
      return { from: daysAgo(timezone, 6), to: today };
    case 'last30':
      return { from: daysAgo(timezone, 29), to: today };
    case 'month':
      return { from: monthStart(timezone), to: today };
    case 'custom':
      return { from: customFrom, to: customTo };
    default:
      return { from: daysAgo(timezone, 29), to: today };
  }
}

const toLabel = (value) =>
  value
    ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
    : '';

function SummaryCard({ label, value, hint }) {
  return (
    <div className="perf-card" title={hint}>
      <span className="perf-card-label">{label}</span>
      <strong className="perf-card-value">{value}</strong>
    </div>
  );
}

function SortTh({ column, sort, order, onSort }) {
  if (!column.sortable) {
    return (
      <th scope="col" className="perf-th-agent">
        {column.label}
      </th>
    );
  }
  const active = sort === column.key;
  return (
    <th scope="col">
      <button
        type="button"
        className={`perf-sort${active ? ' is-active' : ''}`}
        onClick={() => onSort(column.key)}
        title={`Sort by ${column.label}`}
      >
        {column.label}
        <span className="perf-sort-caret" aria-hidden="true">
          {active ? (order === 'asc' ? '↑' : '↓') : ''}
        </span>
      </button>
    </th>
  );
}

function PerformanceTable({ data, sort, order, onSort, onOpenDetail }) {
  return (
    <div className="perf-table-wrap">
      <table className="perf-table">
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <SortTh
                key={column.key}
                column={column}
                sort={sort}
                order={order}
                onSort={onSort}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {data.agents.map((agent) => (
            <tr
              key={agent.id}
              className="perf-row"
              onClick={() => onOpenDetail(agent.id)}
              title={`View ${agent.name}'s daily breakdown`}
            >
              <td className="perf-th-agent">
                <strong>{agent.name}</strong>
                <span className="perf-agent-email">{agent.email}</span>
              </td>
              <td>{agent.chatsHandled}</td>
              <td>{agent.messagesSent}</td>
              <td>{agent.customers}</td>
              <td>{formatDuration(agent.averageResponseTimeSeconds)}</td>
              <td>{agent.open}</td>
              <td>{agent.pending}</td>
              <td>{agent.resolved}</td>
              <td>{agent.closed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DailyBreakdown({ detail }) {
  return (
    <div className="perf-table-wrap">
      <table className="perf-table perf-daily">
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Chats handled</th>
            <th scope="col">Customers</th>
            <th scope="col">Messages sent</th>
          </tr>
        </thead>
        <tbody>
          {detail.daily.map((row) => (
            <tr key={row.day}>
              <td>{toLabel(row.day)}</td>
              <td>{row.chats_handled}</td>
              <td>{row.customers}</td>
              <td>{row.messages_sent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AgentPerformance({ onClose }) {
  const [timezone, setTimezone] = useState(null);
  const [preset, setPreset] = useState('last30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [order, setOrder] = useState(DEFAULT_ORDER);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);

  const [detailAgentId, setDetailAgentId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  const searchTimer = useRef(null);
  const listRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    api
      .getAwaySettings()
      .then((payload) => {
        if (!cancelled) setTimezone(payload.settings?.timezone || 'Asia/Kolkata');
      })
      .catch(() => {
        if (!cancelled) setTimezone('Asia/Kolkata');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const debounceSearch = (value) => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(value.trim()), 300);
  };

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const customValid = preset !== 'custom' || (customFrom && customTo && customFrom <= customTo);

  useEffect(() => {
    if (!timezone || !customValid) return;
    const range = resolveRange(preset, timezone, customFrom, customTo);
    if (!range.from || !range.to) return;

    const requestId = ++listRequest.current;
    setLoading(true);
    setError(null);
    setData(null);
    api
      .getAgentPerformance({
        from: range.from,
        to: range.to,
        search: search || undefined,
        sort,
        order,
      })
      .then((payload) => {
        if (requestId !== listRequest.current) return;
        setData(payload);
      })
      .catch((err) => {
        if (requestId !== listRequest.current) return;
        setError(err instanceof ApiError ? err.message : 'Performance data could not be loaded.');
      })
      .finally(() => {
        if (requestId !== listRequest.current) return;
        setLoading(false);
      });
  }, [preset, timezone, customFrom, customTo, customValid, search, sort, order, reloadTick]);

  useEffect(() => {
    if (!detailAgentId || !timezone || !customValid) return;
    const range = resolveRange(preset, timezone, customFrom, customTo);
    if (!range.from || !range.to) return;

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    api
      .getAgentPerformanceDetail(detailAgentId, { from: range.from, to: range.to })
      .then((payload) => {
        if (!cancelled) setDetail(payload);
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err instanceof ApiError ? err.message : 'Agent detail could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailAgentId, timezone, preset, customFrom, customTo, customValid]);

  const changeSort = (key) => {
    if (sort === key) {
      setOrder((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSort(key);
    setOrder(key === 'response' ? 'asc' : 'desc');
  };

  const openDetail = (agentId) => {
    setDetailAgentId(agentId);
    setDetail(null);
    setDetailError(null);
  };

  const closeDetail = () => {
    setDetailAgentId(null);
    setDetail(null);
    setDetailError(null);
  };

  const hasAnyActivity =
    data &&
    data.agents.length > 0 &&
    data.summary.chatsHandled > 0 &&
    (data.summary.messagesSent > 0 || data.summary.customers > 0);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="staff-modal agent-performance"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-performance-title"
      >
        <div className="modal-header">
          <div>
            <h2 id="agent-performance-title">Agent Performance</h2>
            <p>
              Real conversation and message totals, Admin only. Periods in {timezone ?? 'Asia/Kolkata'}.
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="perf-toolbar">
          <div className="perf-presets" role="tablist" aria-label="Date range">
            {PRESETS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={preset === item.key}
                className={`view-tab perf-preset${preset === item.key ? ' is-active' : ''}`}
                onClick={() => setPreset(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <div className="perf-custom">
              <label className="perf-date-label">
                <span>From</span>
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(event) => setCustomFrom(event.target.value)}
                />
              </label>
              <label className="perf-date-label">
                <span>To</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(event) => setCustomTo(event.target.value)}
                />
              </label>
              {!customValid && <span className="perf-custom-error">From must be on or before To.</span>}
            </div>
          )}

          <label className="perf-search">
            <span className="sr-only">Search agents</span>
            <input
              type="search"
              value={searchInput}
              onChange={(event) => {
                setSearchInput(event.target.value);
                debounceSearch(event.target.value);
              }}
              placeholder="Search agents by name or email"
            />
          </label>
        </div>

        {error && (
          <ErrorBanner
            message={error}
            onRetry={() => setReloadTick((tick) => tick + 1)}
            onDismiss={() => setError(null)}
          />
        )}

        {loading ? (
          <p className="modal-muted">Loading performance data…</p>
        ) : data && !hasAnyActivity ? (
          <p className="modal-muted">{EMPTY_STATE}</p>
        ) : data ? (
          <>
            <div className="perf-summary">
              <SummaryCard label="Total agents" value={data.totalAgents} hint="Agents with data in this period" />
              <SummaryCard label="Chats" value={data.summary.chatsHandled} hint="Conversations handled by the team in this period" />
              <SummaryCard label="Messages" value={data.summary.messagesSent} hint="Outbound messages successfully sent by the team" />
              <SummaryCard label="Customers" value={data.summary.customers} hint="Distinct customers served in this period" />
              <SummaryCard
                label="Avg response"
                value={formatDuration(data.summary.averageResponseTimeSeconds)}
                hint="Average time until a staff member replies to a customer message (weighted across the team)"
              />
            </div>

            {detailAgentId ? (
              <div className="perf-detail">
                <button type="button" className="ghost-button compact perf-back" onClick={closeDetail}>
                  ← All agents
                </button>
                <div className="perf-detail-head">
                  <h3>
                    {detail?.agent?.name ?? 'Agent'}
                    <span className="perf-agent-email">
                      {data.period.from === data.period.to
                        ? toLabel(data.period.from)
                        : `${toLabel(data.period.from)} – ${toLabel(data.period.to)}`}
                    </span>
                  </h3>
                  <div className="perf-detail-stats">
                    <span>Chats handled: <strong>{detail?.agent?.chatsHandled ?? '…'}</strong></span>
                    <span>Customers: <strong>{detail?.agent?.customers ?? '…'}</strong></span>
                    <span>Messages sent: <strong>{detail?.agent?.messagesSent ?? '…'}</strong></span>
                    <span>Avg response: <strong>{formatDuration(detail?.agent?.averageResponseTimeSeconds ?? null)}</strong></span>
                  </div>
                </div>
                {detailError && <ErrorBanner message={detailError} onDismiss={() => setDetailError(null)} />}
                {detailLoading ? (
                  <p className="modal-muted">Loading daily breakdown…</p>
                ) : detail ? (
                  <DailyBreakdown detail={detail} />
                ) : null}
              </div>
            ) : (
              <PerformanceTable
                data={data}
                sort={sort}
                order={order}
                onSort={changeSort}
                onOpenDetail={openDetail}
              />
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}