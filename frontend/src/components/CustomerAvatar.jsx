import { useEffect, useState } from 'react';
import Avatar from './Avatar.jsx';
import { fetchAvatarObjectUrl } from '../lib/api.js';

const DIMENSIONS = { sm: 32, md: 42, lg: 52 };

/**
 * Round customer profile picture with the initials avatar as the loading and
 * no-picture fallback. The photo is streamed through the backend (never the raw
 * Meta url), and clicking it opens a larger preview. Failures fall back to the
 * initials avatar, so a missing or expired picture never blocks the UI.
 */
export default function CustomerAvatar({ name, waId, size = 'md', unread = false }) {
  const [url, setUrl] = useState(null);
  const [ready, setReady] = useState(false);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setReady(false);

    if (!waId) return undefined;

    fetchAvatarObjectUrl(waId)
      .then((objectUrl) => {
        if (alive) {
          setUrl(objectUrl);
          setReady(true);
        }
      })
      .catch(() => {
        if (alive) setReady(false);
      });

    return () => {
      alive = false;
      setPreview(false);
    };
  }, [waId]);

  const dimensions = DIMENSIONS[size] ?? 42;

  const openPreview = (event) => {
    event?.stopPropagation();
    setPreview(true);
  };

  return (
    <span className={`avatar-wrap avatar-${size}`}>
      {ready && url ? (
        <img
          className="avatar-img"
          src={url}
          alt=""
          style={{ width: dimensions, height: dimensions }}
          title="View profile picture"
          role="button"
          tabIndex={0}
          onClick={openPreview}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openPreview();
            }
          }}
        />
      ) : (
        <Avatar name={name} seed={waId} size={size} unread={unread} />
      )}

      {preview && (
        <div className="media-lightbox" onClick={() => setPreview(false)}>
          <img src={url} alt={name ?? 'Contact'} />
          <button type="button" className="media-lightbox-close" onClick={() => setPreview(false)}>
            ×
          </button>
        </div>
      )}
    </span>
  );
}