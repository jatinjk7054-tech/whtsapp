import { colorFor, initials } from '../lib/format.js';

export default function Avatar({ name, seed, size = 'md', unread = false }) {
  const dimensions = { sm: 32, md: 42, lg: 52 }[size] ?? 42;

  return (
    <span
      className={`avatar avatar-${size}${unread ? ' avatar-unread' : ''}`}
      style={{
        width: dimensions,
        height: dimensions,
        background: colorFor(seed ?? name),
      }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}