import React, { useEffect, useRef, useState } from 'react';
import { collection, deleteDoc, doc, getDoc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { db, initAuth } from './firebase';
import { ICE_SERVERS, generateRoomId } from './webrtc';
import { AlertCircle, Check, Copy, Mic, MicOff, PhoneOff, ShieldCheck, UserCheck, UserX, Users, Video as VideoIcon, VideoOff } from 'lucide-react';

export default function MeetingApp() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [name, setName] = useState('');
  const [host, setHost] = useState(false);
  const [state, setState] = useState('home');
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [participants, setParticipants] = useState({});
  const [peerStatus, setPeerStatus] = useState({});
  const [pending, setPending] = useState([]);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const userRef = useRef(null);
  const roomRef = useRef('');
  const streamRef = useRef(null);
  const pcs = useRef({});
  const meta = useRef({});
  const candidates = useRef({});
  const requestUnsub = useRef(null);

  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { roomRef.current = roomId; }, [roomId]);

  useEffect(() => {
    initAuth().then(async (u) => {
      userRef.current = u;
      setUser(u);
      setReady(true);
      const r = new URLSearchParams(window.location.search).get('room');
      if (!r) return;
      const id = r.toLowerCase().trim();
      roomRef.current = id;
      setRoomId(id);
      try {
        const snap = await getDoc(doc(db, 'rooms', id));
        if (snap.exists() && snap.data().hostUid === u.uid) setHost(true);
      } catch (e) { console.error(e); }
      setState('requesting');
    }).catch((e) => {
      console.error(e);
      setError('Authentication failed. Check Firebase Anonymous Auth.');
    });
  }, []);

  const setStatus = (id, value) => setPeerStatus((p) => ({ ...p, [id]: value }));

  const sendSignal = async (to, type, payload = {}) => {
    const r = roomRef.current;
    const u = userRef.current;
    if (!r || !u) return;
    await setDoc(doc(collection(db, 'rooms', r, 'signals')), {
      from: u.uid, to, type, ...payload, createdAt: serverTimestamp()
    });
  };

  const closePeer = (id, removeVideo = true) => {
    const pc = pcs.current[id];
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onnegotiationneeded = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.close();
      delete pcs.current[id];
    }
    delete meta.current[id];
    delete candidates.current[id];
    if (removeVideo) setRemoteStreams((p) => { const n = { ...p }; delete n[id]; return n; });
    setPeerStatus((p) => { const n = { ...p }; delete n[id]; return n; });
  };

  const createPeer = (peerId) => {
    if (pcs.current[peerId]) return pcs.current[peerId];
    const u = userRef.current;
    const r = roomRef.current;
    const stream = streamRef.current;
    if (!u || !r || !stream) return null;

    const pc = new RTCPeerConnection(ICE_SERVERS);
    pcs.current[peerId] = pc;
    candidates.current[peerId] = [];
    meta.current[peerId] = {
      polite: u.uid < peerId,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      restarting: false
    };
    setStatus(peerId, 'connecting');

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.ontrack = (event) => {
      const incoming = event.streams?.[0];
      if (!incoming) return;
      setRemoteStreams((p) => ({ ...p, [peerId]: incoming }));
      setStatus(peerId, 'connected');
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal(peerId, 'candidate', { candidate: event.candidate.toJSON() }).catch(console.error);
    };

    pc.onnegotiationneeded = async () => {
      const m = meta.current[peerId];
      if (!m || pcs.current[peerId] !== pc) return;
      try {
        m.makingOffer = true;
        await pc.setLocalDescription();
        await sendSignal(peerId, pc.localDescription.type, { sdp: pc.localDescription.sdp });
      } catch (e) {
        console.error('Negotiation failed:', e);
      } finally {
        m.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log('[WebRTC]', u.uid, peerId, 'connection', s);
      if (s === 'connected') setStatus(peerId, 'connected');
      else if (s === 'disconnected') setStatus(peerId, 'disconnected');
      else if (s === 'failed') setStatus(peerId, 'failed');
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log('[WebRTC]', u.uid, peerId, 'ICE', s);
      if (s === 'connected' || s === 'completed') setStatus(peerId, 'connected');
      if (s === 'failed') {
        setStatus(peerId, 'failed');
        const m = meta.current[peerId];
        if (m && !m.restarting) {
          m.restarting = true;
          try { pc.restartIce(); } catch (_) {}
          setTimeout(() => { if (meta.current[peerId]) meta.current[peerId].restarting = false; }, 5000);
        }
      }
    };

    return pc;
  };

  const startMeeting = async (id, displayName, isHost) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      });
      streamRef.current = stream;
      setLocalStream(stream);
      setMic(stream.getAudioTracks()[0]?.enabled ?? true);
      setCam(stream.getVideoTracks()[0]?.enabled ?? true);
      await setDoc(doc(db, 'rooms', id, 'participants', userRef.current.uid), {
        participantId: userRef.current.uid,
        displayName,
        isHost,
        joinedAt: serverTimestamp()
      });
      setState('meeting');
    } catch (e) {
      console.error(e);
      setError(e?.name === 'NotAllowedError' ? 'Please allow camera and microphone access.' : 'Could not access camera and microphone.');
    }
  };

  const createMeeting = async (e) => {
    e.preventDefault();
    if (!name.trim() || !userRef.current) return;
    setError('');
    try {
      const id = generateRoomId();
      await setDoc(doc(db, 'rooms', id), { status: 'active', hostUid: userRef.current.uid, createdAt: serverTimestamp() });
      roomRef.current = id;
      setRoomId(id);
      setHost(true);
      window.history.pushState({}, '', `?room=${id}`);
      await startMeeting(id, name.trim(), true);
    } catch (e) {
      console.error(e);
      setError('Failed to create meeting.');
    }
  };

  const requestJoin = async (e) => {
    e.preventDefault();
    if (!name.trim() || !roomRef.current || !userRef.current) return;
    setError('');
    if (host) {
      await startMeeting(roomRef.current, name.trim(), true);
      return;
    }
    try {
      const requestRef = doc(db, 'rooms', roomRef.current, 'requests', userRef.current.uid);
      await setDoc(requestRef, { displayName: name.trim(), status: 'pending', createdAt: serverTimestamp() });
      setState('waiting');
      if (requestUnsub.current) requestUnsub.current();
      requestUnsub.current = onSnapshot(requestRef, async (snap) => {
        if (!snap.exists()) return;
        const s = snap.data().status;
        if (s === 'approved') {
          requestUnsub.current?.();
          requestUnsub.current = null;
          await startMeeting(roomRef.current, name.trim(), false);
        } else if (s === 'denied') {
          requestUnsub.current?.();
          requestUnsub.current = null;
          setState('denied');
        }
      });
    } catch (e) {
      console.error(e);
      setError('Meeting does not exist, has ended, or access was blocked.');
    }
  };

  useEffect(() => {
    if (state !== 'meeting' || !roomId || !user) return;

    const roomUnsub = onSnapshot(doc(db, 'rooms', roomId), (snap) => {
      if (snap.exists() && snap.data().status === 'ended') leaveMeeting('Meeting ended by host.');
    });

    let reqUnsub = () => {};
    if (host) {
      reqUnsub = onSnapshot(query(collection(db, 'rooms', roomId, 'requests'), where('status', '==', 'pending')), (snap) => {
        setPending(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      });
    }

    const participantsUnsub = onSnapshot(collection(db, 'rooms', roomId, 'participants'), (snap) => {
      const next = {};
      snap.forEach((d) => { next[d.id] = d.data(); });
      setParticipants(next);
      Object.keys(next).forEach((id) => {
        if (id !== user.uid && !pcs.current[id]) createPeer(id);
      });
      Object.keys(pcs.current).forEach((id) => {
        if (!next[id]) closePeer(id);
      });
    });

    const signalsUnsub = onSnapshot(query(collection(db, 'rooms', roomId, 'signals'), where('to', '==', user.uid)), async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== 'added') continue;
        const ref = change.doc.ref;
        const signal = change.doc.data();
        const peerId = signal.from;
        try {
          const pc = pcs.current[peerId] || createPeer(peerId);
          if (!pc) continue;
          const m = meta.current[peerId];

          if (signal.type === 'offer' || signal.type === 'answer') {
            const description = { type: signal.type, sdp: signal.sdp };
            const readyForOffer = !m.makingOffer && (pc.signalingState === 'stable' || m.settingRemoteAnswer);
            const collision = signal.type === 'offer' && !readyForOffer;
            m.ignoreOffer = !m.polite && collision;
            if (m.ignoreOffer) {
              await deleteDoc(ref);
              continue;
            }
            if (signal.type === 'answer') m.settingRemoteAnswer = true;
            if (collision && m.polite) await pc.setLocalDescription({ type: 'rollback' });
            await pc.setRemoteDescription(description);
            m.settingRemoteAnswer = false;
            const queued = candidates.current[peerId] || [];
            for (const c of queued) await pc.addIceCandidate(c);
            candidates.current[peerId] = [];
            if (signal.type === 'offer') {
              await pc.setLocalDescription();
              await sendSignal(peerId, pc.localDescription.type, { sdp: pc.localDescription.sdp });
            }
          } else if (signal.type === 'candidate') {
            const candidate = new RTCIceCandidate(signal.candidate);
            if (m.ignoreOffer) {
              // Ignore candidates belonging to an offer collision we rejected.
            } else if (pc.remoteDescription) {
              await pc.addIceCandidate(candidate);
            } else {
              candidates.current[peerId] ||= [];
              candidates.current[peerId].push(candidate);
            }
          }
          await deleteDoc(ref);
        } catch (e) {
          console.error('Signal error:', e);
          try { await deleteDoc(ref); } catch (_) {}
        }
      }
    });

    return () => {
      roomUnsub();
      reqUnsub();
      participantsUnsub();
      signalsUnsub();
    };
  }, [state, roomId, user, host]);

  const allow = async (id) => { try { await updateDoc(doc(db, 'rooms', roomId, 'requests', id), { status: 'approved' }); } catch (e) { console.error(e); } };
  const deny = async (id) => { try { await updateDoc(doc(db, 'rooms', roomId, 'requests', id), { status: 'denied' }); } catch (e) { console.error(e); } };

  const leaveMeeting = async (reason = '') => {
    requestUnsub.current?.();
    requestUnsub.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    Object.keys(pcs.current).forEach((id) => closePeer(id));
    if (roomRef.current && userRef.current) {
      try { await deleteDoc(doc(db, 'rooms', roomRef.current, 'participants', userRef.current.uid)); } catch (_) {}
    }
    streamRef.current = null;
    setLocalStream(null);
    setRemoteStreams({});
    setParticipants({});
    setPeerStatus({});
    setPending([]);
    if (reason) setError(reason);
    setState(reason ? 'ended' : 'home');
    window.history.pushState({}, '', window.location.pathname);
  };

  const endMeeting = async () => {
    try { await updateDoc(doc(db, 'rooms', roomId), { status: 'ended' }); } catch (_) {}
    await leaveMeeting();
  };

  const toggleMic = () => {
    const t = streamRef.current?.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setMic(t.enabled);
  };
  const toggleCam = () => {
    const t = streamRef.current?.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setCam(t.enabled);
  };
  const copyLink = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}?room=${roomId}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const ids = Object.keys(participants).filter((id) => id !== user?.uid);
  const total = 1 + ids.length;
  const grid = total <= 1 ? 'grid-1' : total === 2 ? 'grid-2' : 'grid-4';

  return <div>
    {state === 'home' && <div className="auth-wrapper"><div className="card">
      <h1 className="card-title">Minimal Video Meeting</h1>
      <p className="card-subtitle">Invite-only video meetings</p>
      {error && <div style={{ color: '#ef4444', marginBottom: '1rem', textAlign: 'center' }}>{error}</div>}
      <form onSubmit={createMeeting}><div className="form-group"><label className="form-label">Your Name</label><input className="input-field" placeholder="e.g. Alice" value={name} onChange={(e) => setName(e.target.value)} disabled={!ready} required /></div><button className="btn btn-primary" disabled={!ready}>{ready ? 'Create Meeting' : 'Connecting...'}</button></form>
    </div></div>}

    {state === 'requesting' && <div className="auth-wrapper"><div className="card">
      <h1 className="card-title">Join Meeting</h1><p className="card-subtitle">Room ID: <strong>{roomId}</strong></p>
      {error && <div style={{ color: '#ef4444', marginBottom: '1rem', textAlign: 'center' }}>{error}</div>}
      <form onSubmit={requestJoin}><div className="form-group"><label className="form-label">Your Display Name</label><input className="input-field" placeholder="e.g. Bob" value={name} onChange={(e) => setName(e.target.value)} disabled={!ready} required /></div><button className="btn btn-primary" disabled={!ready}>{ready ? (host ? 'Enter Meeting (Host)' : 'Request to Join') : 'Connecting...'}</button></form>
    </div></div>}

    {state === 'waiting' && <div className="auth-wrapper"><div className="card status-box"><div className="spinner"/><h2 className="card-title">Waiting for Host...</h2><p className="card-subtitle">The host will review your request shortly.</p></div></div>}
    {state === 'denied' && <div className="auth-wrapper"><div className="card status-box"><AlertCircle size={48} color="#ef4444"/><h2 className="card-title">Request Declined</h2><p className="card-subtitle">The host did not admit you.</p><button className="btn btn-secondary" onClick={() => { setState('home'); window.history.pushState({}, '', window.location.pathname); }}>Back to Home</button></div></div>}
    {state === 'ended' && <div className="auth-wrapper"><div className="card status-box"><h2 className="card-title">Meeting Ended</h2><p className="card-subtitle">{error || 'This meeting has finished.'}</p><button className="btn btn-primary" onClick={() => { setError(''); setState('home'); }}>Return to Home</button></div></div>}

    {state === 'meeting' && <div className="room-container">
      <header className="room-header"><div className="room-info"><span className="room-badge"><Users size={14}/> Room: {roomId}</span>{host && <span className="room-badge" style={{ borderColor: '#3b82f6', color: '#60a5fa' }}><ShieldCheck size={14}/> Host</span>}</div><button className="invite-btn" onClick={copyLink}>{copied ? <Check size={15}/> : <Copy size={15}/>} {copied ? 'Copied' : 'Copy Invite Link'}</button></header>
      <main className="video-grid-wrapper"><div className={`video-grid ${grid}`}>
        <Tile name={`${name} (You)`} stream={localStream} local cam={cam} mic={mic} status="connected"/>
        {ids.map((id) => <Tile key={id} name={`${participants[id]?.displayName || 'Participant'}${participants[id]?.isHost ? ' (Host)' : ''}`} stream={remoteStreams[id] || null} local={false} cam={Boolean(remoteStreams[id])} mic status={peerStatus[id] || 'connecting'}/>) }
      </div>
      {host && pending.length > 0 && <div className="requests-panel"><div className="requests-title"><Users size={16}/> Pending Requests ({pending.length})</div>{pending.map((r) => <div className="request-item" key={r.id}><span className="request-name">{r.displayName}</span><div className="request-actions"><button className="btn-xs btn-success" onClick={() => allow(r.id)}><UserCheck size={14}/> Allow</button><button className="btn-xs btn-danger" onClick={() => deny(r.id)}><UserX size={14}/> Deny</button></div></div>)}</div>}
      </main>
      <footer className="room-controls"><button className={`btn btn-icon ${mic ? 'btn-secondary' : 'active-off'}`} onClick={toggleMic}>{mic ? <Mic size={20}/> : <MicOff size={20}/>}</button><button className={`btn btn-icon ${cam ? 'btn-secondary' : 'active-off'}`} onClick={toggleCam}>{cam ? <VideoIcon size={20}/> : <VideoOff size={20}/>}</button><button className="btn btn-icon btn-danger" onClick={() => leaveMeeting()}><PhoneOff size={20}/></button>{host && <button className="btn btn-danger" style={{ width: 'auto', padding: '0.65rem 1.25rem' }} onClick={endMeeting}>End Meeting</button>}</footer>
    </div>}
  </div>;
}

function Tile({ name, stream, local = false, cam = true, mic = true, status }) {
  const ref = useRef(null);
  useEffect(() => {
    const video = ref.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    const play = () => video.play().catch(() => {});
    if (video.readyState >= 2) play(); else video.onloadedmetadata = play;
    return () => { video.onloadedmetadata = null; };
  }, [stream]);
  const initial = name?.replace(' (You)', '').charAt(0).toUpperCase() || 'P';
  return <div className="video-card" style={{ position: 'relative' }}>
    {stream && cam ? <video ref={ref} autoPlay playsInline muted={local} className={`video-element ${local ? 'video-mirror' : ''}`}/> : <div className="avatar-placeholder"><div className="avatar-circle">{initial}</div></div>}
    <div className="participant-badge"><span>{name}</span>{!mic && <MicOff size={13} color="#ef4444"/>}</div>
    {!local && !stream && <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,.65)', borderRadius: 8, padding: '4px 8px', fontSize: 12 }}>{status === 'failed' ? 'Connection failed' : 'Connecting…'}</div>}
  </div>;
}
