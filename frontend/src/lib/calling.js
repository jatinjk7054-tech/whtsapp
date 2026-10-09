/**
 * Module 12 — browser-side WebRTC helpers for WhatsApp voice calling.
 *
 * Meta is the signalling relay; this browser is the media endpoint. We use a
 * non-trickle ICE exchange (wait for gathering to finish, then send the full
 * SDP) because Meta's Calling API expects the complete offer/answer. STUN/TURN
 * servers come from the backend so they are configured in one place.
 */

export function callingSupported() {
  return Boolean(
    typeof window !== 'undefined' &&
      window.RTCPeerConnection &&
      navigator.mediaDevices?.getUserMedia
  );
}

/** getUserMedia needs a secure context; localhost is exempt by the browsers. */
export function isSecureContextForMedia() {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext || /^https?:$/.test(window.location.protocol);
}

/**
 * Acquires the microphone. Throws an Error with a human-readable message so the
 * overlay can show exactly what to fix (blocked, no device, already in use).
 */
export async function getMicrophone() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      throw new Error('Microphone permission is blocked. Allow it in your browser and try again.');
    }
    if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
      throw new Error('No microphone was found on this device.');
    }
    if (error?.name === 'NotReadableError') {
      throw new Error('The microphone is already in use by another app.');
    }
    throw new Error(error?.message || 'Could not access the microphone.');
  }
}

export function createPeerConnection(iceServers) {
  return new RTCPeerConnection({
    iceServers: Array.isArray(iceServers) && iceServers.length ? iceServers : undefined,
    // Meta is ICE-lite and awaits our full candidate list, so one transport is
    // all we need.
    bundlePolicy: 'max-bundle',
  });
}

/** Resolves once ICE gathering completes, or after a short safety timeout. */
export function waitForIceGathering(peer, timeoutMs = 2500) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      peer.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    peer.addEventListener('icegatheringstatechange', onChange);
  });
}

/** Builds the local SDP offer (returns the serialized SDP, not the object). */
export async function createOffer(peer) {
  const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
  await peer.setLocalDescription(offer);
  await waitForIceGathering(peer);
  return peer.localDescription.sdp;
}

/** Consumes Meta's offer and produces the local answer SDP. */
export async function createAnswer(peer, remoteOfferSdp) {
  await peer.setRemoteDescription({ type: 'offer', sdp: remoteOfferSdp });
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await waitForIceGathering(peer);
  return peer.localDescription.sdp;
}

/** Applies Meta's answer to an outbound call. */
export async function applyAnswer(peer, remoteAnswerSdp) {
  if (!peer || peer.signalingState === 'closed') return;
  if (peer.remoteDescription) return;
  await peer.setRemoteDescription({ type: 'answer', sdp: remoteAnswerSdp });
}

export function closePeer(peer) {
  try {
    peer?.getSenders?.().forEach((sender) => {
      try {
        sender.track?.stop();
      } catch {
        /* ignore */
      }
    });
    peer?.close();
  } catch {
    /* ignore */
  }
}

export function stopStream(stream) {
  try {
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    /* ignore */
  }
}

/** mm:ss (or h:mm:ss) for the in-call timer. */
export function formatCallDuration(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
