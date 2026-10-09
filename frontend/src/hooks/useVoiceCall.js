import { useCallback, useEffect, useRef, useState } from 'react';
import { api, terminateCallOnUnload } from '../lib/api.js';
import {
  applyAnswer,
  callingSupported,
  closePeer,
  createAnswer,
  createOffer,
  createPeerConnection,
  getMicrophone,
  isSecureContextForMedia,
  stopStream,
} from '../lib/calling.js';

const INCOMING_POLL_MS = 2500;
const ACTIVE_POLL_MS = 1500;
// How long a finished call stays on screen before the overlay closes itself.
const ENDED_LINGER_MS = 4500;
const TERMINAL = ['ended', 'missed', 'failed'];

/**
 * Module 12 — owns the browser side of WhatsApp calling: the WebRTC session,
 * microphone, polling, and the UI phase. It never fakes a connection — the
 * 'connected' phase only appears once the RTCPeerConnection really connects.
 */
export function useVoiceCall({ enabled, onAuthError } = {}) {
  const [config, setConfig] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const activeCallRef = useRef(null);
  const lingerRef = useRef(null);
  const timerRef = useRef(null);
  const startingRef = useRef(false);

  const teardownMedia = useCallback(() => {
    closePeer(pcRef.current);
    pcRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    clearInterval(timerRef.current);
    timerRef.current = null;
    setMuted(false);
    setElapsed(0);
  }, []);

  const finishCall = useCallback(
    (call, terminalPhase) => {
      teardownMedia();
      activeCallRef.current = call ?? null;
      setActiveCall(call ?? null);
      setPhase(TERMINAL.includes(terminalPhase) ? terminalPhase : 'ended');
      clearTimeout(lingerRef.current);
      lingerRef.current = setTimeout(() => {
        activeCallRef.current = null;
        setActiveCall(null);
        setPhase('idle');
      }, ENDED_LINGER_MS);
    },
    [teardownMedia]
  );

  const startTimer = useCallback((answeredAt) => {
    if (timerRef.current) return;
    const base = answeredAt ? new Date(answeredAt).getTime() : Date.now();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - base) / 1000)));
    tick();
    timerRef.current = setInterval(tick, 1000);
  }, []);

  const attachPeerHandlers = useCallback(
    (peer) => {
      peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'connected') {
          setPhase('connected');
          startTimer(activeCallRef.current?.answeredAt);
        } else if (peer.connectionState === 'failed') {
          setError('The call connection failed.');
          setPhase('failed');
        }
      });
    },
    [startTimer]
  );

  // Feature/eligibility configuration, loaded once per session.
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    api
      .getCallingStatus(controller.signal)
      .then((payload) => setConfig(payload))
      .catch((err) => {
        if (err?.name !== 'AbortError') onAuthError?.(err);
      });
    return () => controller.abort();
  }, [enabled, onAuthError]);

  // Detect inbound ringing calls while this browser is idle.
  useEffect(() => {
    if (!enabled || !config?.enabled || activeCall || incomingCall) return undefined;

    let cancelled = false;
    const poll = async () => {
      try {
        const payload = await api.listIncomingCalls();
        if (cancelled) return;
        const first = payload.items?.[0] ?? null;
        if (first) {
          setIncomingCall(first);
          setPhase('ringing');
        }
      } catch (err) {
        if (err?.name !== 'AbortError') onAuthError?.(err);
      }
    };

    poll();
    const timer = setInterval(() => {
      if (!document.hidden) poll();
    }, INCOMING_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, config?.enabled, activeCall, incomingCall, onAuthError]);

  // Keep the active call in sync with the server (answer SDP, accept, hang-up).
  useEffect(() => {
    if (!enabled || !activeCall?.id) return undefined;

    let cancelled = false;
    const poll = async () => {
      try {
        const call = await api.getCall(activeCall.id);
        if (cancelled) return;
        activeCallRef.current = call;
        setActiveCall(call);

        if (
          call.direction === 'outbound' &&
          call.sdpAnswer &&
          pcRef.current &&
          !pcRef.current.remoteDescription
        ) {
          await applyAnswer(pcRef.current, call.sdpAnswer).catch(() => {});
        }

        if (TERMINAL.includes(call.status)) {
          finishCall(call, call.status);
        } else if (call.direction === 'outbound' && call.status === 'ringing') {
          setPhase((current) => (current === 'connected' ? current : 'ringing'));
        }
      } catch (err) {
        if (err?.name !== 'AbortError') onAuthError?.(err);
      }
    };

    poll();
    const timer = setInterval(() => {
      if (!document.hidden) poll();
    }, ACTIVE_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, activeCall?.id, onAuthError, finishCall]);

  // Hang up if the page is unloaded mid-call. keepalive lets the request finish
  // even as the document goes away; the server sweep is the final safety net.
  useEffect(() => {
    const onUnload = () => {
      const call = activeCallRef.current;
      if (call?.id && !TERMINAL.includes(call.status)) terminateCallOnUnload(call.id);
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  // Leaving the session (sign-out) must release the microphone immediately.
  useEffect(() => {
    if (enabled) return;
    if (!activeCallRef.current && !streamRef.current && !pcRef.current) return;
    teardownMedia();
    activeCallRef.current = null;
    setActiveCall(null);
    setIncomingCall(null);
    setPhase('idle');
  }, [enabled, teardownMedia]);

  // Final cleanup on unmount.
  useEffect(
    () => () => {
      teardownMedia();
      clearTimeout(lingerRef.current);
    },
    [teardownMedia]
  );

  const startCall = useCallback(
    async (conversation) => {
      if (!conversation?.id) return;
      setError(null);

      if (!config?.enabled) {
        setError('WhatsApp calling is not enabled for this workspace.');
        return;
      }
      if (!callingSupported() || !isSecureContextForMedia()) {
        setError('Voice calling needs a modern browser on a secure (HTTPS) connection.');
        return;
      }
      if (activeCallRef.current || startingRef.current) return;

      startingRef.current = true;
      try {
        const stream = await getMicrophone();
        streamRef.current = stream;

        const peer = createPeerConnection(config.iceServers);
        pcRef.current = peer;
        stream.getTracks().forEach((track) => peer.addTrack(track, stream));
        attachPeerHandlers(peer);

        setPhase('connecting');
        const sdpOffer = await createOffer(peer);
        const call = await api.startCall(conversation.id, sdpOffer);

        activeCallRef.current = call;
        setActiveCall(call);
        setIncomingCall(null);
        setPhase('connecting');
      } catch (err) {
        teardownMedia();
        onAuthError?.(err);
        setPhase('idle');
        setError(err?.message || 'The call could not be started.');
      } finally {
        startingRef.current = false;
      }
    },
    [config, attachPeerHandlers, teardownMedia, onAuthError]
  );

  const answerCall = useCallback(async () => {
    const call = incomingCall;
    if (!call) return;
    setError(null);

    if (!callingSupported() || !isSecureContextForMedia()) {
      setError('Voice calling needs a modern browser on a secure (HTTPS) connection.');
      return;
    }
    if (!call.sdpOffer) {
      setError('This call is missing its audio offer.');
      setIncomingCall(null);
      setPhase('idle');
      return;
    }

    startingRef.current = true;
    try {
      const stream = await getMicrophone();
      streamRef.current = stream;

      const peer = createPeerConnection(config.iceServers);
      pcRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      attachPeerHandlers(peer);

      setPhase('connecting');
      const sdpAnswer = await createAnswer(peer, call.sdpOffer);
      const answered = await api.answerCall(call.id, sdpAnswer);

      activeCallRef.current = answered;
      setActiveCall(answered);
      setIncomingCall(null);
    } catch (err) {
      teardownMedia();
      onAuthError?.(err);
      setIncomingCall(null);
      setPhase('idle');
      setError(err?.message || 'The call could not be answered.');
    } finally {
      startingRef.current = false;
    }
  }, [incomingCall, config, attachPeerHandlers, teardownMedia, onAuthError]);

  const declineCall = useCallback(async () => {
    const call = incomingCall;
    if (!call) return;
    setIncomingCall(null);
    setPhase('idle');
    try {
      await api.rejectCall(call.id);
    } catch (err) {
      onAuthError?.(err);
    }
  }, [incomingCall, onAuthError]);

  const endCall = useCallback(async () => {
    const call = activeCallRef.current;
    teardownMedia();

    if (!call?.id) {
      activeCallRef.current = null;
      setActiveCall(null);
      setPhase('idle');
      return;
    }

    try {
      const updated = await api.terminateCall(call.id);
      finishCall(updated, updated.status);
    } catch (err) {
      onAuthError?.(err);
      finishCall({ ...call, status: 'ended' }, 'ended');
    }
  }, [teardownMedia, finishCall, onAuthError]);

  const toggleMute = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    setMuted((prev) => {
      const next = !prev;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      return next;
    });
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    config,
    incomingCall,
    activeCall,
    phase,
    error,
    muted,
    elapsed,
    supported: callingSupported(),
    secure: isSecureContextForMedia(),
    startCall,
    answerCall,
    declineCall,
    endCall,
    toggleMute,
    clearError,
  };
}
