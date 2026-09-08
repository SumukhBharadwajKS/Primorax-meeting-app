import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db, initAuth } from './firebase';
import { ICE_SERVERS, generateRoomId } from './webrtc';
import {
  ArrowRight,
  Check,
  Copy,
  Link2,
  Loader2,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Shield,
  Sparkles,
  UserCheck,
  UserRound,
  UserX,
  Users,
  Video,
  VideoOff,
  Wifi,
  X,
} from 'lucide-react';

const SIGNAL_TYPES = new Set(['offer', 'answer', 'candidate']);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function MeetingApp() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [name, setName] = useState('');
  const [host, setHost] = useState(false);
  const [screen, setScreen] = useState('home');
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [participants, setParticipants] = useState({});
  const [peerStatus, setPeerStatus] = useState({});
  const [pending, setPending] = useState([]);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const userRef = useRef(null);
  const roomRef = useRef('');
  const streamRef = useRef(null);
  const peersRef = useRef({});
  const metaRef = useRef({});
  const candidateQueueRef = useRef({});
  const requestUnsubRef = useRef(null);

  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { roomRef.current = roomId; }, [roomId]);

  useEffect(() => {
    let alive = true;
    initAuth().then(async (u) => {
      if (!alive) return;
      userRef.current = u;
      setUser(u);
      setReady(true);
      const id = new URLSearchParams(window.location.search).get('room')?.trim().toLowerCase();
      if (!id) return;
      roomRef.current = id;
      setRoomId(id);
      try {
        const snap = await getDoc(doc(db, 'rooms', id));
        if (snap.exists() && snap.data().hostUid === u.uid) setHost(true);
      } catch (_) {
        // Guests are intentionally unable to read a room until they create a join request.
      }
      setScreen('join');
    }).catch((e) => {
      console.error(e);
      setError('Could not connect to the meeting service.');
    });
    return () => { alive = false; };
  }, []);

  const setStatus = (id, value) => {
    setPeerStatus((current) => ({ ...current, [id]: value }));
  };

  const sendSignal = async (to, type, payload = {}) => {
    const room = roomRef.current;
    const current = userRef.current;
    if (!room || !current || !SIGNAL_TYPES.has(type)) return;
    await setDoc(doc(collection(db, 'rooms', room, 'signals')), {
      from: current.uid,
      to,
      type,
      ...payload,
      createdAt: serverTimestamp(),
    });
  };

  const closePeer = (peerId, removeVideo = true) => {
    const pc = peersRef.current[peerId];
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onnegotiationneeded = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try { pc.close(); } catch (_) {}
      delete peersRef.current[peerId];
    }
    delete metaRef.current[peerId];
    delete candidateQueueRef.current[peerId];
    if (removeVideo) {
      setRemoteStreams((current) => {
        const next = { ...current };
        delete next[peerId];
        return next;
      });
    }
    setPeerStatus((current) => {
      const next = { ...current };
      delete next[peerId];
      return next;
    });
  };

  const createPeer = (peerId) => {
    if (peersRef.current[peerId]) return peersRef.current[peerId];
    const current = userRef.current;
    const stream = streamRef.current;
    if (!current || !stream) return null;

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peersRef.current[peerId] = pc;
    candidateQueueRef.current[peerId] = [];
    metaRef.current[peerId] = {
      polite: current.uid < peerId,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      restartTimer: null,
    };
    setStatus(peerId, 'connecting');

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.ontrack = (event) => {
      const incoming = event.streams?.[0];
      if (!incoming) return;
      setRemoteStreams((currentStreams) => ({ ...currentStreams, [peerId]: incoming }));
      setStatus(peerId, 'connected');
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(peerId, 'candidate', { candidate: event.candidate.toJSON() }).catch(console.error);
      }
    };

    pc.onnegotiationneeded = async () => {
      const meta = metaRef.current[peerId];
      if (!meta || peersRef.current[peerId] !== pc) return;
      try {
        meta.makingOffer = true;
        await pc.setLocalDescription();
        await sendSignal(peerId, pc.localDescription.type, { sdp: pc.localDescription.sdp });
      } catch (e) {
        console.error('WebRTC negotiation error', e);
      } finally {
        meta.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') setStatus(peerId, 'connected');
      else if (state === 'disconnected') setStatus(peerId, 'disconnected');
      else if (state === 'failed') setStatus(peerId, 'failed');
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') setStatus(peerId, 'connected');
      if (state === 'failed') {
        setStatus(peerId, 'failed');
        const meta = metaRef.current[peerId];
        if (meta && !meta.restartTimer) {
          meta.restartTimer = window.setTimeout(() => {
            meta.restartTimer = null;
            const live = peersRef.current[peerId];
            if (live && live.signalingState === 'stable') {
              try { live.restartIce(); } catch (_) {}
            }
          }, 800);
        }
      }
    };

    return pc;
  };

  const startMedia = async () => {
    if (streamRef.current) return streamRef.current;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera and microphone are not available in this browser.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streamRef.current = stream;
    setLocalStream(stream);
    setMic(stream.getAudioTracks()[0]?.enabled ?? true);
    setCam(stream.getVideoTracks()[0]?.enabled ?? true);
    return stream;
  };

  const startMeeting = async (id, displayName, isHost) => {
    setBusy(true);
    setError('');
    try {
      await startMedia();
      await setDoc(doc(db, 'rooms', id, 'participants', userRef.current.uid), {
        participantId: userRef.current.uid,
        displayName,
        isHost,
        joinedAt: serverTimestamp(),
      });
      setScreen('meeting');
    } catch (e) {
      console.error(e);
      const message = e?.name === 'NotAllowedError'
        ? 'Camera/microphone permission was blocked. Allow access and try again.'
        : e?.message || 'Could not start your camera and microphone.';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const createMeeting = async (event) => {
    event.preventDefault();
    if (!ready || !userRef.current || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const id = generateRoomId();
      await setDoc(doc(db, 'rooms', id), {
        status: 'active',
        hostUid: userRef.current.uid,
        createdAt: serverTimestamp(),
      });
      roomRef.current = id;
      setRoomId(id);
      setHost(true);
      window.history.replaceState({}, '', `?room=${id}`);
      await startMeeting(id, name.trim(), true);
    } catch (e) {
      console.error(e);
      setError('Could not create the meeting. Check Firebase and try again.');
      setBusy(false);
    }
  };

  const requestJoin = async (event) => {
    event.preventDefault();
    if (!ready || !userRef.current || !roomRef.current || !name.trim()) return;
    setBusy(true);
    setError('');
    if (host) {
      await startMeeting(roomRef.current, name.trim(), true);
      return;
    }
    try {
      const requestRef = doc(db, 'rooms', roomRef.current, 'requests', userRef.current.uid);
      await setDoc(requestRef, {
        displayName: name.trim(),
        status: 'pending',
        createdAt: serverTimestamp(),
      });
      setScreen('waiting');
      requestUnsubRef.current?.();
      requestUnsubRef.current = onSnapshot(requestRef, async (snap) => {
        if (!snap.exists()) return;
        const status = snap.data().status;
        if (status === 'approved') {
          requestUnsubRef.current?.();
          requestUnsubRef.current = null;
          await startMeeting(roomRef.current, name.trim(), false);
        }
        if (status === 'denied') {
          requestUnsubRef.current?.();
          requestUnsubRef.current = null;
          setBusy(false);
          setScreen('denied');
        }
      });
    } catch (e) {
      console.error(e);
      setError('That meeting is unavailable or the invite is invalid.');
      setBusy(false);
    }
  };

  useEffect(() => {
    if (screen !== 'meeting' || !roomId || !user) return undefined;

    const roomUnsub = onSnapshot(doc(db, 'rooms', roomId), (snap) => {
      if (snap.exists() && snap.data().status === 'ended') {
        leaveMeeting('The host ended the meeting.', false);
      }
    });

    const participantsUnsub = onSnapshot(collection(db, 'rooms', roomId, 'participants'), (snap) => {
      const next = {};
      snap.forEach((item) => { next[item.id] = item.data(); });
      setParticipants(next);

      Object.keys(next).forEach((id) => {
        if (id !== user.uid && !peersRef.current[id]) createPeer(id);
      });
      Object.keys(peersRef.current).forEach((id) => {
        if (!next[id]) closePeer(id);
      });
    });

    const signalsUnsub = onSnapshot(
      query(collection(db, 'rooms', roomId, 'signals'), where('to', '==', user.uid)),
      async (snap) => {
        for (const change of snap.docChanges()) {
          if (change.type !== 'added') continue;
          const signalRef = change.doc.ref;
          const signal = change.doc.data();
          if (!SIGNAL_TYPES.has(signal.type)) continue;
          const peerId = signal.from;
          try {
            const pc = peersRef.current[peerId] || createPeer(peerId);
            if (!pc) continue;
            const meta = metaRef.current[peerId];

            if (signal.type === 'offer' || signal.type === 'answer') {
              const description = { type: signal.type, sdp: signal.sdp };
              const readyForOffer = !meta.makingOffer &&
                (pc.signalingState === 'stable' || meta.settingRemoteAnswer);
              const collision = signal.type === 'offer' && !readyForOffer;
              meta.ignoreOffer = !meta.polite && collision;

              if (meta.ignoreOffer) {
                await deleteDoc(signalRef);
                continue;
              }

              if (signal.type === 'answer') meta.settingRemoteAnswer = true;
              if (collision && meta.polite) {
                await pc.setLocalDescription({ type: 'rollback' });
              }

              await pc.setRemoteDescription(description);
              meta.settingRemoteAnswer = false;

              const queue = candidateQueueRef.current[peerId] || [];
              for (const candidate of queue) await pc.addIceCandidate(candidate);
              candidateQueueRef.current[peerId] = [];

              if (signal.type === 'offer') {
                await pc.setLocalDescription();
                await sendSignal(peerId, 'answer', { sdp: pc.localDescription.sdp });
              }
            } else if (signal.type === 'candidate') {
              if (meta.ignoreOffer) {
                await deleteDoc(signalRef);
                continue;
              }
              const candidate = new RTCIceCandidate(signal.candidate);
              if (pc.remoteDescription) await pc.addIceCandidate(candidate);
              else {
                candidateQueueRef.current[peerId] ||= [];
                candidateQueueRef.current[peerId].push(candidate);
              }
            }

            await deleteDoc(signalRef);
          } catch (e) {
            console.error('Signal processing failed', e);
            // Keep the message if it failed so a transient listener/state issue does not destroy signaling.
          }
        }
      },
    );

    let requestUnsub = () => {};
    if (host) {
      requestUnsub = onSnapshot(
        query(collection(db, 'rooms', roomId, 'requests'), where('status', '==', 'pending')),
        (snap) => setPending(snap.docs.map((item) => ({ id: item.id, ...item.data() }))),
      );
    }

    return () => {
      roomUnsub();
      participantsUnsub();
      signalsUnsub();
      requestUnsub();
    };
  }, [screen, roomId, user, host]);

  const allow = async (id) => {
    try {
      await updateDoc(doc(db, 'rooms', roomId, 'requests', id), { status: 'approved' });
      setPending((current) => current.filter((item) => item.id !== id));
    } catch (e) { console.error(e); }
  };

  const deny = async (id) => {
    try {
      await updateDoc(doc(db, 'rooms', roomId, 'requests', id), { status: 'denied' });
      setPending((current) => current.filter((item) => item.id !== id));
    } catch (e) { console.error(e); }
  };

  const leaveMeeting = async (reason = '', returnHome = true) => {
    requestUnsubRef.current?.();
    requestUnsubRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    Object.keys(peersRef.current).forEach((id) => closePeer(id));
    if (roomRef.current && userRef.current) {
      try { await deleteDoc(doc(db, 'rooms', roomRef.current, 'participants', userRef.current.uid)); } catch (_) {}
    }
    streamRef.current = null;
    setLocalStream(null);
    setRemoteStreams({});
    setParticipants({});
    setPeerStatus({});
    setPending([]);
    setBusy(false);
    if (reason) setError(reason);
    if (returnHome) {
      setScreen(reason ? 'ended' : 'home');
      window.history.replaceState({}, '', window.location.pathname);
    }
  };

  const endMeeting = async () => {
    try { await updateDoc(doc(db, 'rooms', roomId), { status: 'ended' }); } catch (_) {}
    await leaveMeeting();
  };

  const toggleMic = () => {
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMic(track.enabled);
  };

  const toggleCam = () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCam(track.enabled);
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}?room=${roomId}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (_) {
      setError('Could not copy the invite link.');
    }
  };

  const remoteIds = Object.keys(participants).filter((id) => id !== user?.uid);
  const tileCount = Math.max(1, remoteIds.length + 1);

  if (screen === 'meeting') {
    return (
      <MeetingRoom
        name={name}
        host={host}
        roomId={roomId}
        localStream={localStream}
        remoteStreams={remoteStreams}
        participants={participants}
        peerStatus={peerStatus}
        remoteIds={remoteIds}
        tileCount={tileCount}
        mic={mic}
        cam={cam}
        pending={pending}
        copied={copied}
        onCopy={copyInvite}
        onToggleMic={toggleMic}
        onToggleCam={toggleCam}
        onLeave={() => leaveMeeting()}
        onEnd={endMeeting}
        onAllow={allow}
        onDeny={deny}
      />
    );
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="landing-nav">
        <div className="brand"><span className="brand-mark"><Video size={18} /></span><span>Primora<span className="brand-accent">X</span></span></div>
        <div className="nav-pill"><span className="live-dot" /> Private meetings</div>
      </header>

      <main className="landing-main">
        {screen === 'home' && (
          <section className="hero-layout">
            <div className="hero-copy">
              <div className="eyebrow"><Sparkles size={15} /> Simple video meetings, without the clutter</div>
              <h1>Meet face to face.<br /><span>Just send a link.</span></h1>
              <p className="hero-text">Create a private room, invite your people, and start talking. No account, no downloads, no noise.</p>
              <div className="trust-row"><span><Shield size={15} /> Invite-only</span><span><Wifi size={15} /> Peer-to-peer</span><span><Users size={15} /> Up to 4 people</span></div>
            </div>
            <div className="entry-card">
              <div className="card-glow" />
              <div className="entry-icon"><Video size={23} /></div>
              <h2>Start a meeting</h2>
              <p>Create a room and share the invite with your team.</p>
              {error && <ErrorBox text={error} />}
              <form onSubmit={createMeeting}>
                <label>Your name</label>
                <div className="field-wrap"><UserRound size={18} /><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sumukh" autoComplete="name" disabled={!ready || busy} required /></div>
                <button className="primary-button" disabled={!ready || busy}>{busy ? <><Loader2 className="spin" size={18} /> Starting...</> : <>Create meeting <ArrowRight size={18} /></>}</button>
              </form>
              <div className="card-note">You'll be the host and can approve who joins.</div>
            </div>
          </section>
        )}

        {screen === 'join' && (
          <section className="center-layout">
            <div className="entry-card join-card">
              <div className="join-top"><span className="small-kicker">INVITATION</span><span className="room-code">{roomId}</span></div>
              <div className="entry-icon"><Link2 size={23} /></div>
              <h2>Join the meeting</h2>
              <p>Enter the name you'd like other participants to see.</p>
              {error && <ErrorBox text={error} />}
              <form onSubmit={requestJoin}>
                <label>Your name</label>
                <div className="field-wrap"><UserRound size={18} /><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alex" disabled={!ready || busy} required /></div>
                <button className="primary-button" disabled={!ready || busy}>{busy ? <><Loader2 className="spin" size={18} /> Connecting...</> : host ? <>Enter as host <ArrowRight size={18} /></> : <>Request to join <ArrowRight size={18} /></>}</button>
              </form>
              <button className="text-button" onClick={() => { setScreen('home'); setError(''); window.history.replaceState({}, '', window.location.pathname); }}>← Back</button>
            </div>
          </section>
        )}

        {screen === 'waiting' && <StatusCard icon={<Loader2 className="spin" size={25} />} title="Waiting for the host" text="Your request is with the host. Keep this tab open — we'll let you in automatically." />}
        {screen === 'denied' && <StatusCard icon={<X size={25} />} title="Request declined" text="The host didn't approve your request this time." action={<button className="secondary-button" onClick={() => { setScreen('join'); setError(''); }}>Try again</button>} />}
        {screen === 'ended' && <StatusCard icon={<PhoneOff size={25} />} title="Meeting ended" text={error || 'This meeting has finished.'} action={<button className="secondary-button" onClick={() => { setScreen('home'); setError(''); }}>Back to home</button>} />}
      </main>
    </div>
  );
}

function ErrorBox({ text }) {
  return <div className="error-box">{text}</div>;
}

function StatusCard({ icon, title, text, action }) {
  return <section className="center-layout"><div className="status-card"><div className="status-icon">{icon}</div><h2>{title}</h2><p>{text}</p>{action}</div></section>;
}

function MeetingRoom({ name, host, roomId, localStream, remoteStreams, participants, peerStatus, remoteIds, tileCount, mic, cam, pending, copied, onCopy, onToggleMic, onToggleCam, onLeave, onEnd, onAllow, onDeny }) {
  const [showRequests, setShowRequests] = useState(true);
  const connected = Object.values(peerStatus).filter((s) => s === 'connected').length;
  const gridClass = useMemo(() => `meeting-grid tiles-${Math.min(tileCount, 4)}`, [tileCount]);

  return (
    <div className="meeting-shell">
      <header className="meeting-topbar">
        <div className="meeting-brand"><span className="brand-mark small"><Video size={16} /></span><span>Primora<span className="brand-accent">X</span></span></div>
        <div className="meeting-meta"><span className="status-live"><span className="live-dot" /> Live</span><span className="room-label">{roomId}</span><span className="people-count"><Users size={15} /> {tileCount}</span></div>
        <button className="invite-button" onClick={onCopy}>{copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Invite'}</button>
      </header>

      <main className="meeting-stage">
        <div className={gridClass}>
          <VideoTile stream={localStream} name={`${name} (You)`} local cam={cam} mic={mic} status="connected" />
          {remoteIds.map((id) => (
            <VideoTile
              key={id}
              stream={remoteStreams[id]}
              name={participants[id]?.displayName || 'Participant'}
              host={participants[id]?.isHost}
              local={false}
              cam={Boolean(remoteStreams[id])}
              mic={true}
              status={peerStatus[id] || 'connecting'}
            />
          ))}
        </div>

        {host && pending.length > 0 && showRequests && (
          <aside className="request-popover">
            <div className="request-head"><div><strong>Join requests</strong><span>{pending.length} waiting</span></div><button onClick={() => setShowRequests(false)}><X size={17} /></button></div>
            {pending.map((request) => (
              <div className="request-row" key={request.id}>
                <div className="request-avatar">{request.displayName?.charAt(0)?.toUpperCase() || 'P'}</div>
                <div className="request-person"><strong>{request.displayName}</strong><span>wants to join</span></div>
                <div className="request-actions"><button className="approve" onClick={() => onAllow(request.id)}><UserCheck size={16} /></button><button className="reject" onClick={() => onDeny(request.id)}><UserX size={16} /></button></div>
              </div>
            ))}
          </aside>
        )}
        {host && pending.length > 0 && !showRequests && <button className="request-bubble" onClick={() => setShowRequests(true)}><Users size={16} /> {pending.length} request{pending.length > 1 ? 's' : ''}</button>}

        <div className="connection-pill"><span className={`connection-dot ${connected > 0 ? 'good' : ''}`} /> {connected > 0 ? `${connected} connected` : tileCount === 1 ? 'Waiting for people' : 'Connecting...'}</div>
      </main>

      <footer className="meeting-controls">
        <div className="control-group">
          <ControlButton active={mic} onClick={onToggleMic} icon={mic ? <Mic /> : <MicOff />} label={mic ? 'Mute' : 'Unmute'} />
          <ControlButton active={cam} onClick={onToggleCam} icon={cam ? <Video /> : <VideoOff />} label={cam ? 'Camera' : 'Camera off'} />
          <ControlButton active icon={<MonitorUp />} label="Share" disabled />
        </div>
        <button className="leave-button" onClick={onLeave}><PhoneOff size={19} /><span>Leave</span></button>
        {host && <button className="end-button" onClick={onEnd}>End meeting</button>}
      </footer>
    </div>
  );
}

function ControlButton({ icon, label, active, onClick, disabled }) {
  return <button className={`control-button ${active ? '' : 'off'}`} onClick={onClick} disabled={disabled}><span>{icon}</span><small>{label}</small></button>;
}

function VideoTile({ stream, name, host, local, cam, mic, status }) {
  const videoRef = useRef(null);
  const [needsPlay, setNeedsPlay] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return undefined;
    video.srcObject = stream;
    const play = () => video.play().then(() => setNeedsPlay(false)).catch(() => setNeedsPlay(true));
    video.onloadedmetadata = play;
    play();
    return () => { video.onloadedmetadata = null; };
  }, [stream]);

  const initial = name?.replace(' (You)', '').trim().charAt(0).toUpperCase() || 'P';
  const live = Boolean(stream && cam);

  return (
    <article className={`video-tile ${local ? 'local-tile' : ''}`}>
      {live ? <video ref={videoRef} autoPlay playsInline muted={local} className={local ? 'mirrored' : ''} onClick={() => videoRef.current?.play().catch(() => {})} /> : <div className="avatar-view"><div className="avatar-large">{initial}</div><span>{status === 'failed' ? 'Connection failed' : status === 'connecting' ? 'Connecting…' : 'Camera off'}</span></div>}
      <div className="tile-shade" />
      <div className="tile-label"><span className="tile-name">{name}{host && <Shield size={13} />}</span><span className="tile-mic">{mic ? <Mic size={13} /> : <MicOff size={13} />}</span></div>
      {needsPlay && !local && <button className="tap-audio" onClick={() => videoRef.current?.play().then(() => setNeedsPlay(false))}>Tap to play audio</button>}
    </article>
  );
}
