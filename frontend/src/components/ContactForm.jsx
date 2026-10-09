import { useEffect, useRef, useState } from 'react';

/**
 * Add Contact modal. Reuses the template-modal shell so it looks like the rest
 * of the app's dialogs. Saving posts { name, mobile, notes, tags } to
 * POST /api/contacts; an existing number comes back as 409 "Contact already
 * exists" (surfaced through `error`) and never creates a duplicate.
 */
export default function ContactForm({ open, saving, error, onSave, onCancel }) {
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');
  const nameRef = useRef(null);

  useEffect(() => {
    if (open) {
      setName('');
      setMobile('');
      setNotes('');
      setTags('');
      nameRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const invalid = !name.trim() || !mobile.trim();

  const submit = (event) => {
    event.preventDefault();
    if (invalid || saving) return;
    onSave({
      name: name.trim(),
      mobile: mobile.trim(),
      notes: notes.trim(),
      tags: tags.trim(),
    });
  };

  return (
    <div className="template-modal-backdrop" onMouseDown={onCancel}>
      <form
        className="template-modal contact-form-modal"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="template-modal-head">
          <strong>Add contact</strong>
          <button type="button" onClick={onCancel}>×</button>
        </div>

        <label className="contact-field">
          <span>Customer name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Jatin Sharma"
            maxLength={120}
            autoComplete="off"
          />
        </label>

        <label className="contact-field">
          <span>Mobile number</span>
          <input
            value={mobile}
            onChange={(event) => setMobile(event.target.value)}
            placeholder="e.g. 919876543210"
            maxLength={32}
            inputMode="tel"
            autoComplete="off"
          />
        </label>

        <label className="contact-field">
          <span>Tags</span>
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="e.g. New, VIP, Follow-up"
            maxLength={300}
            autoComplete="off"
          />
        </label>

        <label className="contact-field">
          <span>Internal notes</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Notes your team can see in the customer profile. Never sent to the customer."
            maxLength={4000}
            rows={3}
          />
        </label>

        <p className="contact-hint">
          WhatsApp number with country code. When this customer messages, their replies are
          matched to the saved contact.
        </p>

        {error && <p className="composer-error">{error}</p>}

        <div className="send-actions">
          <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="send-button" disabled={invalid || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
