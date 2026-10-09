import { STATUS_LABELS } from '../lib/format.js';

export default function StatusBadge({ status }) {
  return <span className={`status-badge status-${status ?? 'open'}`}>{STATUS_LABELS[status] ?? status}</span>;
}