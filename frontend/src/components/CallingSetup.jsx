import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Module 12 — admin setup checklist. Eligibility is mostly configured in Meta's
 * dashboard, so this is honest: it reports what the backend can verify and lists
 * the manual steps, rather than pretending calling works before it does.
 */
export default function CallingSetup({ config: initialConfig, onClose }) {
  const [config, setConfig] = useState(initialConfig ?? null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (config) return undefined;
    const controller = new AbortController();
    api
      .getCallingStatus(controller.signal)
      .then(setConfig)
      .catch((err) => {
        if (err?.name !== 'AbortError') setError(err?.message || 'Configuration could not be loaded.');
      });
    return () => controller.abort();
  }, [config]);

  const iceServers = config?.iceServers ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="calling-setup-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Calling setup">
        <div className="modal-head">
          <h2>WhatsApp Calling setup</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="modal-subtitle">
          {config?.enabled
            ? 'Calling is configured on this backend. Confirm the manual steps below in Meta.'
            : 'Calling is not switched on yet. The checklist below shows what is still required.'}
        </p>

        {error && <p className="call-history-error">{error}</p>}

        {config && (
          <>
            <ul className="calling-checklist">
              {config.checklist.map((item) => (
                <li key={item.id} className={`checklist-item state-${item.done === true ? 'done' : item.done === false ? 'todo' : 'manual'}`}>
                  <span className="checklist-mark" aria-hidden="true">
                    {item.done === true ? '✓' : item.done === false ? '✕' : '•'}
                  </span>
                  <span>
                    {item.label}
                    {item.done === null && <em className="checklist-manual"> (verify in Meta)</em>}
                  </span>
                </li>
              ))}
            </ul>

            <div className="calling-notes">
              <h3>ICE servers</h3>
              <p className="modal-muted">
                {iceServers.length > 0
                  ? iceServers.map((server) => server.urls ?? JSON.stringify(server)).join(', ')
                  : 'None configured.'}
              </p>
              <p className="modal-hint">
                Set <code>CALLING_ICE_SERVERS</code> (JSON) on the backend to add a TURN relay for customers
                behind symmetric NAT. Values are shared with signed-in staff's browsers.
              </p>
            </div>

            <div className="calling-notes">
              <h3>Good to know</h3>
              <ul className="calling-facts">
                <li>The customer must grant call permission, or call you first.</li>
                <li>Accepting an inbound call must happen within ~30–60 seconds of it ringing.</li>
                <li>Only official Cloud API calling is used; no audio is recorded or stored.</li>
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
