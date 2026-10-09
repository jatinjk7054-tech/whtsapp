import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { MESSAGE_TYPE_LABELS } from '../lib/format.js';
import { Mp3Encoder } from '@breezystack/lamejs';
import TemplateLibrary from './TemplateLibrary.jsx';
import QuickReplyPicker from './QuickReplyPicker.jsx';

// Heavy (~300 kB) and only needed the first time the picker is opened, so it
// stays out of the initial bundle.
const EmojiPicker = lazy(() => import('emoji-picker-react'));

const MAX_LENGTH = 4096;
const MAX_ATTACHMENT_SIZE = 15 * 1024 * 1024;
const MP3_BLOCK = 1152 * 16;

function floatToInt16(samples) {
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function encodeMp3(samples, sampleRate) {
  const encoder = new Mp3Encoder(1, sampleRate, 32);
  const int16 = floatToInt16(samples);
  const parts = [];
  for (let i = 0; i < int16.length; i += MP3_BLOCK) {
    const chunk = encoder.encodeBuffer(int16.subarray(i, i + MP3_BLOCK));
    if (chunk.length) parts.push(chunk);
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(tail);
  return new Blob(parts, { type: 'audio/mpeg' });
}

function fileType(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'document';
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function secondsLabel(ms) {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatBytes(size) {
  if (!size) return '0 B';
  const units = ['B', 'KB', 'MB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** i).toFixed(1)} ${units[i]}`;
}

export default function MessageComposer({
  canSend,
  canSendFreeText,
  disabledHint,
  templateWindowHint,
  conversation,
  quickRepliesVersion = 0,
  replyTo,
  replySenderName,
  onCancelReply,
  onSend,
  onSendTemplate,
  onSendMedia,
}) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [pendingFileUrl, setPendingFileUrl] = useState(null);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [previewAudioUrl, setPreviewAudioUrl] = useState(null);
  const [previewAudioFile, setPreviewAudioFile] = useState(null);
  const textareaRef = useRef(null);
  const emojiWrapRef = useRef(null);
  const galleryRef = useRef(null);
  const documentRef = useRef(null);
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const processorNodeRef = useRef(null);
  const pcmChunksRef = useRef([]);
  const sampleRateRef = useRef(44100);
  const timerRef = useRef(null);
  const pendingFileUrlRef = useRef(null);
  const previewAudioUrlRef = useRef(null);

  useEffect(() => {
    setBody('');
    setError(null);
  }, [canSend, canSendFreeText]);

  // A quick reply belongs to one thread: switching conversations closes it.
  useEffect(() => setQuickOpen(false), [conversation?.id]);

  // The picker closes on any click outside it (its own search, skin-tone menus
  // and the toggle button all live inside the wrapper) and on Escape.
  useEffect(() => {
    if (!emojiOpen) return undefined;
    const onDown = (event) => {
      if (!emojiWrapRef.current?.contains(event.target)) setEmojiOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setEmojiOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [emojiOpen]);

  useEffect(
    () => () => {
      clearInterval(timerRef.current);
      if (processorNodeRef.current) processorNodeRef.current.onaudioprocess = null;
      processorNodeRef.current?.disconnect();
      sourceNodeRef.current?.disconnect();
      audioCtxRef.current?.close();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (previewAudioUrlRef.current) URL.revokeObjectURL(previewAudioUrlRef.current);
      if (pendingFileUrlRef.current) URL.revokeObjectURL(pendingFileUrlRef.current);
    },
    []
  );

  const autoGrow = () => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
  };

  // Insert the picked emoji at the caret (or at the end when the field never
  // had focus), keeping the caret right after it so several can be typed in a
  // row without retapping the field.
  const insertEmoji = (emoji) => {
    if (!emoji) return;
    const node = textareaRef.current;
    if (!node) {
      setBody((prev) => `${prev.slice(0, MAX_LENGTH)}${emoji}`.slice(0, MAX_LENGTH));
      return;
    }
    const start = node.selectionStart ?? node.value.length;
    const end = node.selectionEnd ?? node.value.length;
    const next = `${node.value.slice(0, start)}${emoji}${node.value.slice(end)}`;
    if (next.length > MAX_LENGTH) return;
    setBody(next);
    requestAnimationFrame(() => {
      const caret = start + emoji.length;
      node.focus();
      node.setSelectionRange(caret, caret);
      autoGrow();
    });
  };

  // Module 6 — drops a quick reply into the draft at the caret. Nothing is
  // sent: the text stays editable until the agent presses Send, which then
  // runs through the normal send path and its normal 24-hour check.
  const insertQuickReply = (text) => {
    if (!text) return;
    const node = textareaRef.current;
    if (!node) {
      setBody((prev) => `${prev.slice(0, MAX_LENGTH)}${text}`.slice(0, MAX_LENGTH));
      return;
    }
    const start = node.selectionStart ?? node.value.length;
    const end = node.selectionEnd ?? node.value.length;
    const next = `${node.value.slice(0, start)}${text}${node.value.slice(end)}`.slice(0, MAX_LENGTH);
    setBody(next);
    requestAnimationFrame(() => {
      const caret = start + text.length;
      node.focus();
      node.setSelectionRange(caret, caret);
      autoGrow();
    });
  };

  // Small "text / media" indication + one-line snippet above the composer.
  const replyKind = replyTo
    ? replyTo.type === 'text'
      ? 'Text'
      : replyTo.type === 'template'
        ? 'Template'
        : (MESSAGE_TYPE_LABELS[replyTo.type] ?? 'Attachment')
    : null;
  const replySnippet = replyTo?.body && replyTo.body !== `[${replyTo.type}]`
    ? replyTo.body
    : replyKind;

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed || sending || !canSend || !canSendFreeText) return;
    setSending(true);
    setError(null);
    try {
      await onSend(trimmed);
      setBody('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      textareaRef.current?.focus();
    } catch (err) {
      setError(err?.message ?? 'Message could not be sent');
    } finally {
      setSending(false);
    }
  };

  const openTemplates = () => {
    setMenuOpen(false);
    setTemplatesOpen(true);
  };

  const stageFile = (file) => {
    if (!file || sending || !canSend || !canSendFreeText) return;
    setMenuOpen(false);
    if (file.size < 1 || file.size > MAX_ATTACHMENT_SIZE) {
      setError('Attachment must be between 1 byte and 15 MB.');
      return;
    }
    setError(null);
    if (pendingFileUrlRef.current) URL.revokeObjectURL(pendingFileUrlRef.current);
    pendingFileUrlRef.current = URL.createObjectURL(file);
    setPendingFile(file);
    setPendingFileUrl(pendingFileUrlRef.current);
  };

  const cancelPendingFile = () => {
    if (pendingFileUrlRef.current) URL.revokeObjectURL(pendingFileUrlRef.current);
    pendingFileUrlRef.current = null;
    setPendingFile(null);
    setPendingFileUrl(null);
  };

  const sendPendingFile = async () => {
    if (!pendingFile || sending || !canSend || !canSendFreeText) return;
    setSending(true);
    setError(null);
    try {
      const type = fileType(pendingFile);
      const base64 = await toBase64(pendingFile);
      await onSendMedia({ type, filename: pendingFile.name, mimeType: pendingFile.type || 'application/octet-stream', base64 });
      cancelPendingFile();
    } catch (err) {
      setError(err?.message ?? 'Attachment could not be sent');
    } finally {
      setSending(false);
    }
  };

  const startRecording = async () => {
    if (recording || sending || !canSend || !canSendFreeText) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioContextCtor) throw new Error('audio capture not supported');
      const ctx = new AudioContextCtor({ sampleRate: 44100 });
      await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      pcmChunksRef.current = [];
      processor.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(channel.length);
        copy.set(channel);
        pcmChunksRef.current.push(copy);
      };
      source.connect(processor);
      processor.connect(ctx.destination);

      streamRef.current = stream;
      audioCtxRef.current = ctx;
      sourceNodeRef.current = source;
      processorNodeRef.current = processor;
      sampleRateRef.current = ctx.sampleRate || 44100;

      const startedAt = Date.now();
      timerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
      setRecording(true);
    } catch (err) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      const denied = err?.name === 'NotAllowedError';
      setError(denied ? 'Microphone permission was denied.' : `Recording failed: ${err?.message ?? 'unknown error'}`);
    }
  };

  const stopRecording = () => {
    const processor = processorNodeRef.current;
    if (!processor) return;
    clearInterval(timerRef.current);
    processor.onaudioprocess = null;
    processor.disconnect();
    sourceNodeRef.current?.disconnect();
    audioCtxRef.current?.close();
    processorNodeRef.current = null;
    sourceNodeRef.current = null;
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setRecording(false);
    setElapsedMs(0);

    const chunks = pcmChunksRef.current;
    pcmChunksRef.current = [];
    if (!chunks.length) return;
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }

    try {
      const blob = encodeMp3(samples, sampleRateRef.current);
      if (previewAudioUrlRef.current) URL.revokeObjectURL(previewAudioUrlRef.current);
      previewAudioUrlRef.current = URL.createObjectURL(blob);
      setPreviewAudioUrl(previewAudioUrlRef.current);
      setPreviewAudioFile(new File([blob], `voice-note-${Date.now()}.mp3`, { type: 'audio/mpeg' }));
    } catch (err) {
      setError(`Voice note encoding failed: ${err?.message ?? 'unknown error'}`);
    }
  };

  const cancelRecording = () => {
    clearInterval(timerRef.current);
    if (processorNodeRef.current) processorNodeRef.current.onaudioprocess = null;
    processorNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    audioCtxRef.current?.close();
    processorNodeRef.current = null;
    sourceNodeRef.current = null;
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    pcmChunksRef.current = [];
    setRecording(false);
    setElapsedMs(0);
  };

  const clearPreviewAudio = () => {
    if (previewAudioUrlRef.current) URL.revokeObjectURL(previewAudioUrlRef.current);
    previewAudioUrlRef.current = null;
    setPreviewAudioUrl(null);
    setPreviewAudioFile(null);
  };

  const sendVoiceNote = async () => {
    if (!previewAudioFile || sending || !canSend || !canSendFreeText) return;
    setSending(true);
    setError(null);
    try {
      const base64 = await toBase64(previewAudioFile);
      await onSendMedia({ type: 'audio', filename: previewAudioFile.name, mimeType: previewAudioFile.type, base64 });
      clearPreviewAudio();
    } catch (err) {
      setError(err?.message ?? 'Voice note could not be sent');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  const pendingFileKind = pendingFile ? fileType(pendingFile) : null;

  return (
    <div className="composer">
      {error && <p className="composer-error">{error}</p>}
      {disabledHint && <p className="composer-hint">{disabledHint}</p>}
      {templateWindowHint && <p className="composer-hint">{templateWindowHint}</p>}

      {replyTo && (
        <div className="composer-reply">
          <span className="composer-reply-bar" aria-hidden="true" />
          <div className="composer-reply-main">
            <div className="composer-reply-head">
              <strong>Replying to {replySenderName}</strong>
              <button type="button" onClick={onCancelReply} title="Cancel reply" aria-label="Cancel reply">
                ×
              </button>
            </div>
            <p className="composer-reply-text">
              <span className="composer-reply-kind">{replyKind}</span>
              <span className="composer-reply-snippet">{replySnippet}</span>
            </p>
          </div>
        </div>
      )}

      <div className="composer-row">
        <div className="attachment-wrap">
          <button type="button" className="attachment-button" disabled={!canSend || sending} onClick={() => setMenuOpen((v) => !v)} title="Attachments">
            <span aria-hidden="true">＋</span>
          </button>
          {menuOpen && (
            <div className="attachment-menu">
              <button type="button" disabled={!canSendFreeText} onClick={() => galleryRef.current?.click()}>🖼️ Gallery</button>
              <button type="button" disabled={!canSend} onClick={openTemplates}>📋 Template Library</button>
              <button type="button" disabled={!canSendFreeText} onClick={() => documentRef.current?.click()}>📄 Document</button>
            </div>
          )}
          <input ref={galleryRef} hidden type="file" accept="image/*,video/*" onChange={(e) => stageFile(e.target.files?.[0])} />
          <input ref={documentRef} hidden type="file" onChange={(e) => stageFile(e.target.files?.[0])} />
          <input ref={videoRef} hidden type="file" accept="video/*" onChange={(e) => stageFile(e.target.files?.[0])} />
          <input ref={audioRef} hidden type="file" accept="audio/*" onChange={(e) => stageFile(e.target.files?.[0])} />
        </div>

        {/* Quick Replies only insert editable text. The Template Library keeps
            its own button because templates are the only thing Meta allows
            outside the 24-hour window — the two systems stay separate. */}
        <div className="qr-wrap">
          <button
            type="button"
            className="attachment-button composer-qr-button"
            disabled={!canSend || sending}
            onClick={() => setQuickOpen((value) => !value)}
            onMouseDown={(event) => event.stopPropagation()}
            title="Quick Replies"
            aria-label="Quick Replies"
            aria-expanded={quickOpen}
          >
            <span className="qr-btn-icon" aria-hidden="true">↩</span>
            <span className="qr-btn-text">Quick Replies</span>
          </button>

          {quickOpen && !recording && !previewAudioUrl && (
            <QuickReplyPicker
              conversation={conversation}
              canInsert={Boolean(canSend && canSendFreeText)}
              version={quickRepliesVersion}
              onInsert={insertQuickReply}
              onClose={() => setQuickOpen(false)}
            />
          )}
        </div>

        {/* Templates are the only way to talk outside the 24-hour window, so the
            library gets its own button instead of living inside the menu. */}
        <button
          type="button"
          className="attachment-button composer-template-button"
          disabled={!canSend || sending}
          onClick={openTemplates}
          title="Template Library"
          aria-label="Template Library"
        >
          <span aria-hidden="true">📋</span>
        </button>

        {recording ? (
          <div className="recorder-bar">
            <button type="button" className="recorder-cancel" onClick={cancelRecording} title="Discard recording">✕</button>
            <span className="recorder-timer">🔴 {secondsLabel(elapsedMs)}</span>
            <button type="button" className="recorder-stop" onClick={stopRecording} title="Stop recording">■</button>
          </div>
        ) : previewAudioUrl ? (
          <div className="recorder-bar">
            <audio className="recorder-preview" src={previewAudioUrl} controls preload="metadata" />
            <button type="button" className="recorder-cancel" onClick={clearPreviewAudio} title="Delete voice note">🗑</button>
            <button type="button" className="send-button recorder-send" onClick={sendVoiceNote} disabled={sending || !canSendFreeText}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className="composer-input"
            value={body}
            rows={1}
            maxLength={MAX_LENGTH}
            disabled={!canSend || !canSendFreeText || sending}
            placeholder={canSend && canSendFreeText ? 'Type a message…' : 'Use an approved template to start or continue this chat'}
            onChange={(event) => { setBody(event.target.value); autoGrow(); }}
            onKeyDown={handleKeyDown}
          />
        )}

        {!recording && !previewAudioUrl && (
          <div className="emoji-wrap" ref={emojiWrapRef}>
            <button
              type="button"
              className="composer-emoji"
              onClick={() => setEmojiOpen((v) => !v)}
              disabled={!canSend || !canSendFreeText || sending}
              title="Emoji"
              aria-label="Emoji"
              aria-expanded={emojiOpen}
            >
              😊
            </button>
            {emojiOpen && (
              <div className="emoji-panel">
                <Suspense fallback={<div className="emoji-panel-fallback">Loading emoji…</div>}>
                  <EmojiPicker
                    onEmojiClick={(emojiData) => insertEmoji(emojiData.emoji)}
                    width={300}
                    height={380}
                    lazyLoadEmojis
                  />
                </Suspense>
              </div>
            )}
          </div>
        )}

        {!recording && !previewAudioUrl && (
          <button
            type="button"
            className="composer-mic"
            onClick={startRecording}
            disabled={!canSend || !canSendFreeText || sending}
            title="Record a voice note"
          >
            🎤
          </button>
        )}

        {!recording && !previewAudioUrl && (
          <button type="button" className="send-button" onClick={submit} disabled={!canSend || !canSendFreeText || sending || !body.trim()}>
            <span className="send-button-label">{sending ? 'Sending…' : 'Send'}</span>
          </button>
        )}
      </div>

      {canSendFreeText && !recording && !previewAudioUrl && (
        <p className="composer-footnote">Enter to send · Shift + Enter for a new line · {body.length}/{MAX_LENGTH}</p>
      )}

      {pendingFile && (
        <div className="template-modal-backdrop" onMouseDown={cancelPendingFile}>
          <div className="template-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="template-modal-head">
              <strong>Attachment preview</strong>
              <button type="button" onClick={cancelPendingFile}>×</button>
            </div>
            {pendingFileUrl && pendingFileKind === 'image' && (
              <img src={pendingFileUrl} alt="" style={{ width: '100%', maxHeight: 320, objectFit: 'contain', borderRadius: 8 }} />
            )}
            {pendingFileUrl && pendingFileKind === 'video' && (
              <video src={pendingFileUrl} controls autoPlay muted playsInline style={{ width: '100%', maxHeight: 320, borderRadius: 8 }} />
            )}
            {pendingFileUrl && pendingFileKind === 'audio' && (
              <audio src={pendingFileUrl} controls autoPlay preload="metadata" style={{ width: '100%' }} />
            )}
            {pendingFileKind === 'document' && (
              <p className="preview-document">
                <strong>{pendingFile.name}</strong>
                <br />
                <span>{pendingFile.type || 'unknown type'} · {formatBytes(pendingFile.size)}</span>
              </p>
            )}
            <div className="send-actions">
              <button type="button" className="ghost-button" onClick={cancelPendingFile}>Cancel</button>
              <button type="button" className="send-button" onClick={sendPendingFile} disabled={sending}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      {templatesOpen && (
        <TemplateLibrary
          conversation={conversation}
          onSendTemplate={onSendTemplate}
          onClose={() => setTemplatesOpen(false)}
        />
      )}
    </div>
  );
}