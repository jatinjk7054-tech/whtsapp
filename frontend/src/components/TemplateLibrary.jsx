import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Module 4 — the approved Meta WhatsApp Template Library.
 *
 * Lists only templates Meta reports as APPROVED (the backend filters the list),
 * lets the agent search/filter by name, category and language, then collects the
 * exact inputs Meta needs for a send: body/header variables, a media header and
 * dynamic URL button values — with a WhatsApp-style preview next to them.
 *
 * The component never builds Meta payloads itself: it sends a normalized
 * description and the backend validates it against the approved definition
 * before anything is stored or handed to the Cloud API.
 */

const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const MAX_HEADER_BYTES = 15 * 1024 * 1024;

function extractTokens(text) {
  return [...String(text ?? '').matchAll(TOKEN_RE)].map((match) => match[1]);
}

/** Replaces `{{1}}` / `{{name}}` tokens in order; unfilled ones stay visible. */
function substitute(text, values) {
  let index = 0;
  return String(text ?? '').replace(TOKEN_RE, (match) => {
    const value = values?.[index++];
    return value ? String(value) : match;
  });
}

function componentOf(definition, type) {
  return definition?.components?.find((c) => String(c.type ?? '').toUpperCase() === type) ?? null;
}

/** New `BUTTONS: {buttons}` shape and the older `BUTTON + sub_type` shape. */
function buttonsOf(definition) {
  const buttons = [];
  const container = componentOf(definition, 'BUTTONS');
  for (const button of container?.buttons ?? []) {
    buttons.push({
      kind: String(button.type ?? '').toUpperCase(),
      label: String(button.text ?? ''),
      url: button.url ?? null,
      phone: button.phone_number ?? null,
      index: buttons.length,
    });
  }
  for (const component of definition?.components ?? []) {
    if (String(component.type ?? '').toUpperCase() !== 'BUTTON') continue;
    const parameter = (component.parameters ?? []).find((p) => p?.url) ?? {};
    buttons.push({
      kind: String(component.sub_type ?? '').toUpperCase(),
      label: String(parameter.text ?? component.text ?? ''),
      url: parameter.url ?? component.url ?? null,
      phone: component.phone_number ?? parameter.phone_number ?? null,
      index: Number.isInteger(component.index) ? component.index : buttons.length,
    });
  }
  return buttons;
}

function bodySnippet(definition) {
  const text = componentOf(definition, 'BODY')?.text ?? '';
  return text.replace(/\s+/g, ' ').trim();
}

function variableLabel(token) {
  return /^\d+$/.test(token) ? `Variable ${token}` : String(token).replace(/_/g, ' ');
}

function languageLabel(code) {
  try {
    const display = new Intl.DisplayNames(['en'], { type: 'language' });
    const name = display.of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

function titleCase(value) {
  const text = String(value ?? '').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatBytes(size) {
  if (!size) return '0 B';
  const units = ['B', 'KB', 'MB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** i).toFixed(1)} ${units[i]}`;
}

export default function TemplateLibrary({ conversation, onSendTemplate, onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState(null);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('ALL');
  const [language, setLanguage] = useState('ALL');

  const [selected, setSelected] = useState(null);
  const [headerValues, setHeaderValues] = useState([]);
  const [bodyValues, setBodyValues] = useState([]);
  const [buttonValues, setButtonValues] = useState({});
  const [headerFile, setHeaderFile] = useState(null);
  const [headerFileUrl, setHeaderFileUrl] = useState(null);
  const [headerUrl, setHeaderUrl] = useState('');

  const [target, setTarget] = useState(() =>
    conversation
      ? {
          conversationId: conversation.id,
          waId: conversation.contact_wa_id,
          name: conversation.contact_name || '',
        }
      : null
  );
  const [targetQuery, setTargetQuery] = useState('');
  const [directory, setDirectory] = useState([]);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);

  const headerFileUrlRef = useRef(null);

  const loadTemplates = async ({ refresh = false } = {}) => {
    setListError(null);
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const result = await api.listTemplates();
      setItems(result?.items ?? []);
    } catch (error) {
      setListError(error?.message ?? 'Could not load approved templates');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;

    api
      .listTemplates(controller.signal)
      .then((result) => {
        if (alive) setItems(result?.items ?? []);
      })
      .catch((error) => {
        if (alive && error?.name !== 'AbortError') {
          setListError(error?.message ?? 'Could not load approved templates');
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, []);

  // Existing conversations double as the recipient directory.
  useEffect(() => {
    const controller = new AbortController();
    api
      .listConversations({ limit: 100 }, controller.signal)
      .then((result) => setDirectory(result?.items ?? []))
      .catch(() => {})
      .finally(() => {});
    return () => controller.abort();
  }, []);

  useEffect(
    () => () => {
      if (headerFileUrlRef.current) URL.revokeObjectURL(headerFileUrlRef.current);
    },
    []
  );

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const categories = useMemo(() => {
    const found = new Set();
    for (const template of items) {
      if (template.category) found.add(String(template.category).toUpperCase());
    }
    return [...found].sort();
  }, [items]);

  const languages = useMemo(() => {
    const found = new Set();
    for (const template of items) {
      if (template.language) found.add(template.language);
    }
    return [...found].sort();
  }, [items]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((template) => {
      if (category !== 'ALL' && String(template.category ?? '').toUpperCase() !== category) return false;
      if (language !== 'ALL' && template.language !== language) return false;
      if (!needle) return true;
      return (
        String(template.name ?? '').toLowerCase().includes(needle) ||
        bodySnippet(template).toLowerCase().includes(needle)
      );
    });
  }, [items, search, category, language]);

  const header = selected ? componentOf(selected, 'HEADER') : null;
  const headerFormat = String(header?.format ?? '').toUpperCase();
  const isMediaHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat);
  const headerTokens = header && headerFormat === 'TEXT' ? extractTokens(header.text) : [];
  const headerExamples = (Array.isArray(header?.example?.header_text) ? header.example.header_text.flat() : []) ?? [];
  const bodyTokens = selected ? extractTokens(componentOf(selected, 'BODY')?.text) : [];
  const bodyExamples =
    (Array.isArray(componentOf(selected, 'BODY')?.example?.body_text)
      ? componentOf(selected, 'BODY').example.body_text.flat()
      : []) ?? [];
  const footerText = componentOf(selected, 'FOOTER')?.text ?? '';
  const buttons = useMemo(() => (selected ? buttonsOf(selected) : []), [selected]);
  const urlButtons = buttons.filter((button) => button.kind === 'URL' && String(button.url ?? '').includes('{'));

  const selectTemplate = (template) => {
    setSelected(template);
    setHeaderValues(headerExamplesFor(template));
    setBodyValues(bodyExamplesFor(template));
    setButtonValues({});
    setHeaderFile(null);
    setHeaderUrl('');
    setSendError(null);
    if (headerFileUrlRef.current) URL.revokeObjectURL(headerFileUrlRef.current);
    headerFileUrlRef.current = null;
    setHeaderFileUrl(null);
  };

  // Example values seed the inputs as a starting hint but the agent still has to
  // confirm them — nothing is sent untouched.
  function headerExamplesFor(template) {
    const headerDef = componentOf(template, 'HEADER');
    if (!headerDef || String(headerDef.format ?? '').toUpperCase() !== 'TEXT') return [];
    const tokens = extractTokens(headerDef.text);
    const examples = Array.isArray(headerDef.example?.header_text) ? headerDef.example.header_text.flat() : [];
    return tokens.map((_, index) => examples[index] ?? '');
  }

  function bodyExamplesFor(template) {
    const tokens = extractTokens(componentOf(template, 'BODY')?.text);
    const example = componentOf(template, 'BODY')?.example?.body_text;
    const examples = Array.isArray(example) ? example.flat() : [];
    return tokens.map((_, index) => examples[index] ?? '');
  }

  const backToList = () => {
    setSelected(null);
    setSendError(null);
  };

  const targetMatches = useMemo(() => {
    const needle = targetQuery.trim();
    if (!needle) return [];
    const digits = needle.replace(/\D/g, '');
    const lower = needle.toLowerCase();
    return directory
      .filter((conversation) => {
        const name = String(conversation.contact_name ?? '').toLowerCase();
        const waId = String(conversation.contact_wa_id ?? '');
        return name.includes(lower) || (digits && waId.includes(digits));
      })
      .filter((conversation) => conversation.id !== target?.conversationId)
      .slice(0, 6);
  }, [targetQuery, directory, target?.conversationId]);

  const newNumber = (() => {
    const digits = targetQuery.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return null;
    const known = directory.some((conversation) => String(conversation.contact_wa_id) === digits);
    const already = target?.waId === digits;
    return known || already ? null : digits;
  })();

  const pickConversation = (conversation) => {
    setTarget({
      conversationId: conversation.id,
      waId: conversation.contact_wa_id,
      name: conversation.contact_name || '',
    });
    setTargetQuery('');
    setSendError(null);
  };

  const pickNumber = (waId) => {
    setTarget({ conversationId: null, waId, name: '' });
    setTargetQuery('');
    setSendError(null);
  };

  const stageHeaderFile = (file) => {
    if (!file) return;
    if (file.size < 1 || file.size > MAX_HEADER_BYTES) {
      setSendError(`Header media must be between 1 byte and ${formatBytes(MAX_HEADER_BYTES)}.`);
      return;
    }
    if (headerFileUrlRef.current) URL.revokeObjectURL(headerFileUrlRef.current);
    headerFileUrlRef.current = URL.createObjectURL(file);
    setHeaderFile(file);
    setHeaderFileUrl(headerFileUrlRef.current);
    setHeaderUrl('');
    setSendError(null);
  };

  const clearHeaderFile = () => {
    if (headerFileUrlRef.current) URL.revokeObjectURL(headerFileUrlRef.current);
    headerFileUrlRef.current = null;
    setHeaderFile(null);
    setHeaderFileUrl(null);
  };

  const bodyFilled = bodyValues.filter((value) => value?.trim()).length;
  const headerFilled = headerValues.filter((value) => value?.trim()).length;
  const buttonsFilled = urlButtons.filter((button) => buttonValues[button.index]?.trim()).length;
  const mediaReady = !isMediaHeader || Boolean(headerFile || headerUrl.trim());

  const canSend =
    Boolean(selected) &&
    Boolean(target?.waId || target?.conversationId) &&
    bodyFilled === bodyTokens.length &&
    headerFilled === headerTokens.length &&
    buttonsFilled === urlButtons.length &&
    mediaReady &&
    !sending;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setSendError(null);

    try {
      let headerMedia;
      if (isMediaHeader && (headerFile || headerUrl.trim())) {
        const type = headerFormat.toLowerCase();
        if (headerFile) {
          headerMedia = {
            type,
            base64: await toBase64(headerFile),
            filename: headerFile.name,
            mimeType: headerFile.type || 'application/octet-stream',
          };
        } else {
          headerMedia = { type, url: headerUrl.trim() };
        }
      }

      await onSendTemplate({
        ...(target?.conversationId ? { conversationId: target.conversationId } : {}),
        ...(target?.waId && !target?.conversationId ? { waId: target.waId } : {}),
        name: selected.name,
        language: selected.language,
        ...(headerTokens.length ? { headerVariables: headerValues } : {}),
        ...(bodyTokens.length ? { variables: bodyValues } : {}),
        ...(headerMedia ? { headerMedia } : {}),
        ...(urlButtons.length
          ? {
              buttonParams: urlButtons
                .filter((button) => buttonValues[button.index]?.trim())
                .map((button) => ({ index: button.index, value: buttonValues[button.index].trim() })),
            }
          : {}),
      });

      onClose?.();
    } catch (error) {
      setSendError(error?.message ?? 'Template could not be sent');
    } finally {
      setSending(false);
    }
  };

  const renderedBody = selected ? substitute(componentOf(selected, 'BODY')?.text, bodyValues) : '';
  const renderedHeader =
    selected && headerFormat === 'TEXT' ? substitute(header.text, headerValues) : '';
  const previewHeaderUrl = headerFileUrl || headerUrl.trim() || header?.example?.header_handle?.[0] || '';

  return (
    <div className="template-modal-backdrop" onMouseDown={onClose}>
      <div
        className="template-modal tpl-library"
        role="dialog"
        aria-modal="true"
        aria-label="Template Library"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="template-modal-head">
          <strong>Template Library</strong>
          <div className="tpl-head-actions">
            <button
              type="button"
              className="ghost-button compact"
              onClick={() => loadTemplates({ refresh: true })}
              disabled={refreshing || loading}
              title="Re-fetch the approved templates from Meta"
            >
              {refreshing ? 'Refreshing…' : '⟳ Refresh'}
            </button>
            <button type="button" onClick={onClose} aria-label="Close">× </button>
          </div>
        </div>

        {listError && <p className="composer-error">{listError}</p>}

        {loading && !items.length ? (
          <p className="tpl-muted">Loading approved templates…</p>
        ) : !selected ? (
          <>
            <div className="tpl-filters">
              <input
                className="tpl-search"
                type="search"
                value={search}
                placeholder="Search templates by name or text…"
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Search templates"
              />
              <select value={language} onChange={(event) => setLanguage(event.target.value)} aria-label="Filter by language">
                <option value="ALL">All languages</option>
                {languages.map((code) => (
                  <option key={code} value={code}>{languageLabel(code)}</option>
                ))}
              </select>
            </div>

            <div className="tpl-chips">
              <button
                type="button"
                className={category === 'ALL' ? 'tpl-chip is-active' : 'tpl-chip'}
                onClick={() => setCategory('ALL')}
              >
                All
              </button>
              {categories.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={category === value ? 'tpl-chip is-active' : 'tpl-chip'}
                  onClick={() => setCategory(value)}
                >
                  {titleCase(value)}
                </button>
              ))}
              <span className="tpl-count">{filtered.length} of {items.length}</span>
            </div>

            <div className="tpl-cards">
              {filtered.length === 0 && (
                <p className="tpl-muted">
                  {items.length === 0
                    ? 'No approved templates were returned by Meta.'
                    : 'No template matches these filters.'}
                </p>
              )}
              {filtered.map((template) => {
                const headerDef = componentOf(template, 'HEADER');
                const format = String(headerDef?.format ?? '').toUpperCase();
                const tokenCount =
                  extractTokens(headerDef?.format === 'TEXT' ? headerDef.text : '').length +
                  extractTokens(componentOf(template, 'BODY')?.text).length;
                const buttonCount = buttonsOf(template).length;
                return (
                  <button
                    key={`${template.name}-${template.language}`}
                    type="button"
                    className="tpl-card"
                    onClick={() => selectTemplate(template)}
                  >
                    <span className="tpl-card-head">
                      <strong>{template.name}</strong>
                      <span className="tpl-badge tpl-badge-lang">{template.language}</span>
                      {template.category && <span className="tpl-badge">{titleCase(template.category)}</span>}
                      <span className="tpl-badge tpl-badge-ok">{template.status}</span>
                    </span>
                    <span className="tpl-card-body">{bodySnippet(template) || 'No body text'}</span>
                    <span className="tpl-card-meta">
                      {(format === 'TEXT' || format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT'
                        ? `${titleCase(format)} header`
                        : 'No header')}
                      {' · '}
                      {tokenCount} variable{tokenCount === 1 ? '' : 's'}
                      {' · '}
                      {buttonCount} button{buttonCount === 1 ? '' : 's'}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div className="tpl-compose">
            <button type="button" className="back-link" onClick={backToList}>← All templates</button>

            <div className="tpl-compose-head">
              <h3>{selected.name}</h3>
              <span className="tpl-badge tpl-badge-lang">{selected.language}</span>
              {selected.category && <span className="tpl-badge">{titleCase(selected.category)}</span>}
              <span className="tpl-badge tpl-badge-ok">{selected.status}</span>
            </div>

            <div className="tpl-compose-grid">
              <div className="tpl-form">
                <label className="tpl-field">
                  <span className="tpl-label">To</span>
                  <input
                    type="text"
                    value={targetQuery}
                    placeholder={
                      target
                        ? `${target.name || 'Customer'} · +${target.waId}`
                        : 'Search a customer or type a WhatsApp number'
                    }
                    onChange={(event) => setTargetQuery(event.target.value)}
                  />
                  {target && (
                    <button
                      type="button"
                      className="tpl-clear"
                      onClick={() => {
                        setTarget(null);
                        setSendError(null);
                      }}
                      title="Change recipient"
                    >
                      Change
                    </button>
                  )}
                </label>
                {(targetMatches.length > 0 || newNumber) && (
                  <div className="tpl-suggestions">
                    {targetMatches.map((conversation) => (
                      <button key={conversation.id} type="button" onClick={() => pickConversation(conversation)}>
                        <strong>{conversation.contact_name || 'Unnamed'}</strong>
                        <span>+{conversation.contact_wa_id}</span>
                      </button>
                    ))}
                    {newNumber && (
                      <button type="button" onClick={() => pickNumber(newNumber)}>
                        <strong>New chat</strong>
                        <span>+{newNumber}</span>
                      </button>
                    )}
                  </div>
                )}

                {headerFormat === 'TEXT' && headerTokens.length > 0 && (
                  <fieldset className="tpl-fieldset">
                    <legend>Header variables</legend>
                    {headerTokens.map((token, index) => (
                      <label key={`h-${token}-${index}`} className="tpl-field">
                        <span className="tpl-label">{variableLabel(token)}</span>
                        <input
                          type="text"
                          value={headerValues[index] ?? ''}
                          placeholder={headerExamples[index] ? `e.g. ${headerExamples[index]}` : 'Value'}
                          onChange={(event) =>
                            setHeaderValues((previous) => {
                              const next = [...previous];
                              next[index] = event.target.value;
                              return next;
                            })
                          }
                        />
                      </label>
                    ))}
                  </fieldset>
                )}

                {isMediaHeader && (
                  <fieldset className="tpl-fieldset">
                    <legend>{titleCase(headerFormat)} header</legend>
                    <div className="tpl-media-row">
                      <label className="ghost-button compact tpl-file-label">
                        {headerFile ? headerFile.name : 'Choose file'}
                        <input
                          type="file"
                          accept={headerFormat === 'IMAGE' ? 'image/*' : headerFormat === 'VIDEO' ? 'video/*' : '*/*'}
                          hidden
                          onChange={(event) => stageHeaderFile(event.target.files?.[0])}
                        />
                      </label>
                      {headerFile && (
                        <button type="button" className="ghost-button compact" onClick={clearHeaderFile}>Remove</button>
                      )}
                    </div>
                    <label className="tpl-field">
                      <span className="tpl-label">…or paste a {titleCase(headerFormat)} URL</span>
                      <input
                        type="url"
                        value={headerUrl}
                        placeholder="https://…"
                        onChange={(event) => {
                          setHeaderUrl(event.target.value);
                          if (event.target.value) clearHeaderFile();
                        }}
                      />
                    </label>
                    {headerFile && <span className="tpl-muted">{headerFile.name} · {formatBytes(headerFile.size)}</span>}
                  </fieldset>
                )}

                {bodyTokens.length > 0 && (
                  <fieldset className="tpl-fieldset">
                    <legend>Body variables</legend>
                    {bodyTokens.map((token, index) => (
                      <label key={`b-${token}-${index}`} className="tpl-field">
                        <span className="tpl-label">{variableLabel(token)}</span>
                        <input
                          type="text"
                          value={bodyValues[index] ?? ''}
                          placeholder={bodyExamples[index] ? `e.g. ${bodyExamples[index]}` : 'Value'}
                          onChange={(event) =>
                            setBodyValues((previous) => {
                              const next = [...previous];
                              next[index] = event.target.value;
                              return next;
                            })
                          }
                        />
                      </label>
                    ))}
                  </fieldset>
                )}

                {urlButtons.length > 0 && (
                  <fieldset className="tpl-fieldset">
                    <legend>URL button values</legend>
                    {urlButtons.map((button) => (
                      <label key={`btn-${button.index}`} className="tpl-field">
                        <span className="tpl-label">{button.label || `Button ${button.index + 1}`}</span>
                        <input
                          type="text"
                          value={buttonValues[button.index] ?? ''}
                          placeholder={button.url}
                          onChange={(event) =>
                            setButtonValues((previous) => ({ ...previous, [button.index]: event.target.value }))
                          }
                        />
                      </label>
                    ))}
                  </fieldset>
                )}

                {sendError && <p className="composer-error">{sendError}</p>}

                <div className="tpl-send-row">
                  <span className="tpl-muted">
                    {bodyFilled + headerFilled + buttonsFilled} of{' '}
                    {bodyTokens.length + headerTokens.length + urlButtons.length} values filled
                  </span>
                  <button type="button" className="send-button" onClick={send} disabled={!canSend}>
                    {sending ? 'Sending…' : 'Send Template'}
                  </button>
                </div>
              </div>

              <div className="tpl-preview">
                <span className="tpl-preview-label">WhatsApp preview</span>
                <div className="tpl-preview-stage">
                  <div className="tpl-preview-bubble">
                    {previewHeaderUrl && headerFormat === 'IMAGE' && (
                      <img src={previewHeaderUrl} alt="" className="tpl-preview-media" />
                    )}
                    {previewHeaderUrl && headerFormat === 'VIDEO' && (
                      <video src={previewHeaderUrl} className="tpl-preview-media" controls playsInline />
                    )}
                    {previewHeaderUrl && headerFormat === 'DOCUMENT' && (
                      <div className="tpl-preview-doc">📄 {header?.example?.filename ?? 'Document'}</div>
                    )}
                    {headerFormat === 'TEXT' && renderedHeader && (
                      <p className="tpl-preview-header">{renderedHeader}</p>
                    )}
                    <p className="tpl-preview-body">{renderedBody}</p>
                    {footerText && <div className="tpl-preview-footer">{footerText}</div>}
                    {buttons.map((button) => (
                      <div className="tpl-preview-button" key={`preview-${button.index}`}>
                        {button.kind === 'URL'
                          ? substitute(button.url, [buttonValues[button.index] ?? ''])
                          : button.label}
                      </div>
                    ))}
                    <span className="tpl-preview-meta">12:04 PM ✓✓</span>
                  </div>
                </div>
                <span className="tpl-muted">
                  Preview is an approximation. WhatsApp renders the final message on the customer's phone.
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
