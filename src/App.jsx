import React, { useEffect, useRef, useState } from 'react';
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
  where
} from 'firebase/firestore';
import { db, initAuth } from './firebase';
import { ICE_SERVERS, generateRoomId } from './webrtc';
import {
  AlertCircle,
  Check,
  Copy,
  Mic,
  MicOff,
  PhoneOff,
  ShieldCheck,
  UserCheck,
  UserX,
  Users,
  Video as VideoIcon,
  VideoOff
} from 'lucide-react';

export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [appState, setAppState] = useState('home');
  const [localStream, setLocalStream] = useState(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isCamOn, setIsCamOn] = useState(true);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [participants, setParticipants] = useState({});
  const [connectionStates, setConnectionStates] = useState({});
  const [pendingRequests, setPendingRequests] = useState([]);
  const [copiedLink, setCopiedLink] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const peerConnections = useRef({});
  const candidateQueues = useRef({});
  const localStreamRef = useRef(null);
  const currentUserRef = useRef(null);
  const roomIdRef = useRef('');

  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    initAuth()
      .then(async (user) => {
        setCurrentUser(user);
        currentUserRef.current = user;
        setAuthReady(true);

        const roomParam = new URLSearchParams(window.location.search).get('room');
        if (!roomParam) return;

        const formattedRoom = roomParam.toLowerCase().trim();
        setRoomId(formattedRoom);
        roomIdRef.current = formattedRoom;

        try {
          const snap = await getDoc(doc(db, 'rooms', formattedRoom));
          if (snap.exists() && snap.data().hostUid === user.uid) setIsHost(true);
        } catch (err) {
          console.error('Room lookup failed:', err);
        }
        setAppState('requesting');
      })
      .catch((err) => {
        console.error('Anonymous auth failed:', err);
        setErrorMsg('Authentication failed. Check Firebase Anonymous Auth.');
      });
  }, []);

  const handleCreateMeeting = async (e) => {
    e.preventDefault();
    if (!displayName.trim() || !currentUser) return;
    setErrorMsg('');

    try {
      const newRoomId = generateRoomId();
      await setDoc(doc(db, 'rooms', newRoomId), {
        status: 'active',
        hostUid: currentUser.uid,
        createdAt: serverTimestamp()
      });

      setRoomId(newRoomId);
      roomIdRef.current = newRoomId;
      setIsHost(true);
      window.history.pushState({}, '', `?room=${newRoomId}`);
      await startMeetingRoom(newRoomId, displayName.trim(), true);
    } catch (err) {
      console.error('Create meeting failed:', err);
      setErrorMsg('Failed to create meeting. Check Firestore rules.');
    }
  };

  const handleRequestJoin = async (e) => {
    e.preventDefault();
    if (!displayName.trim() || !roomId.trim() || !currentUser) return;
    setErrorMsg('');

    const targetRoomId = roomId.trim();
    const requestRef = doc(db, 'rooms', targetRoomId, 'requests', currentUser.uid);

    try {
      if (isHost) {
        await startMeetingRoom(targetRoomId, displayName.trim(), true);
        return;
      }

      await setDoc(requestRef, {
        displayName: displayName.trim(),
        status: 'pending',
        createdAt: serverTimestamp()
      });
      setAppState('waiting');

      const unsub = onSnapshot(requestRef, async (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (data.status === 'approved') {
          unsub();
          await startMeetingRoom(targetRoomId, displayName.trim(), false);
        } else if (data.status === 'denied') {
          unsub();
          setAppState('denied');
        }
      });
    } catch (err) {
      console.error('Join request failed:', err);
      setErrorMsg('Meeting does not exist, has ended, or access was blocked.');
    }
  };

  const startMeetingRoom = async (activeRoomId, name, hostFlag) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      });

      localStreamRef.current = stream;
      setLocalStream(stream);
      setIsMicOn(stream.getAudioTracks().some((t) => t.enabled));
      setIsCamOn(stream.getVideoTracks().some((t) => t.enabled));

      await setDoc(doc(db, 'rooms', activeRoomId, 'participants', currentUser.uid), {
        participantId: currentUser.uid,
        displayName: name,
        isHost: hostFlag,
        joinedAt: serverTimestamp()
      });

      setAppState('meeting');
    } catch (err) {
      console.error('Media permission failed:', err);
      setErrorMsg(err?.name === 'NotAllowedError'
        ? 'Please allow camera and microphone access in your browser.'
        : 'Could not access camera and microphone.');
    }
  };

  const setPeerStatus = (peerId, status) => {
    setConnectionStates((prev) => ({ ...prev, [peerId]: status }));
  };

  const removeRemotePeer = (peerId) => {
    setRemoteStreams((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  };

  const closePeerConnection = (peerId, clearRemote = true) => {
    const pc = peerConnections.current[peerId];
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      pc.close();
      delete peerConnections.current[peerId];
    }
    delete candidateQueues.current[peerId];
    if (clearRemote) removeRemotePeer(peerId);
    setConnectionStates((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  };

  const createPeerConnection = (peerId, makeOffer) => {
    if (peerConnections.current[peerId]) return peerConnections.current[peerId];

    const user = currentUserRef.current;
    const activeRoom = roomIdRef.current;
    if (!user || !activeRoom || !localStreamRef.current) return null;

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnections.current[peerId] = pc;
    candidateQueues.current[peerId] ||= [];
    setPeerStatus(peerId, 'connecting');

    localStreamRef.current.getTracks().forEach((track) => {
      pc.addTrack(track, localStreamRef.current);
    });

    pc.ontrack = (event) => {
      const stream = event.streams?.[0];
      if (!stream) return;
      setRemoteStreams((prev) => ({ ...prev, [peerId]: { stream } }));
      setPeerStatus(peerId, 'connected');
    };

    pc.onicecandidate = async (event) => {
      if (!event.candidate) return;
      try {
        await setDoc(doc(collection(db, 'rooms', activeRoom, 'signals')), {
          from: user.uid,
          to: peerId,
          type: 'candidate',
          candidate: event.candidate.toJSON(),
          createdAt: serverTimestamp()
        });
      } catch (err) {
        console.error('ICE candidate send failed:', err);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      setPeerStatus(peerId, state === 'completed' ? 'connected' : state);
      console.log('[WebRTC]', user.uid, '->', peerId, 'ICE:', state);

      if (state === 'failed') {
        setPeerStatus(peerId, 'failed');
        if (user.uid > peerId && peerConnections.current[peerId] === pc) {
          closePeerConnection(peerId);
          setTimeout(() => createPeerConnection(peerId, true), 800);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log('[WebRTC]', user.uid, '->', peerId, 'connection:', state);
      if (state === 'connected') setPeerStatus(peerId, 'connected');
      if (state === 'disconnected') setPeerStatus(peerId, 'disconnected');
      if (state === 'failed') setPeerStatus(peerId, 'failed');
    };

    if (makeOffer) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => setDoc(doc(collection(db, 'rooms', activeRoom, 'signals')), {
          from: user.uid,
          to: peerId,
          type: 'offer',
          sdp: pc.localDescription.sdp,
          createdAt: serverTimestamp()
        }))
        .catch((err) => console.error('Offer creation failed:', err));
    }

    return pc;
  };

  useEffect(() => {
    if (appState !== 'meeting' || !roomId || !currentUser) return;

    const roomUnsub = onSnapshot(doc(db, 'rooms', roomId), (snap) => {
      if (snap.exists() && snap.data().status === 'ended') leaveMeeting('Meeting ended by host.');
    });

    let requestsUnsub = () => {};
    if (isHost) {
      const requestsQuery = query(
        collection(db, 'rooms', roomId, 'requests'),
        where('status', '==', 'pending')
      );
      requestsUnsub = onSnapshot(requestsQuery, (snapshot) => {
        setPendingRequests(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
      });
    }

    const participantsUnsub = onSnapshot(
      collection(db, 'rooms', roomId, 'participants'),
      (snapshot) => {
        const next = {};
        snapshot.forEach((d) => { next[d.id] = d.data(); });
        setParticipants(next);

        Object.keys(next).forEach((peerId) => {
          if (peerId === currentUser.uid) return;
          // One deterministic initiator prevents offer collisions.
          if (currentUser.uid > peerId && !peerConnections.current[peerId]) {
            createPeerConnection(peerId, true);
          }
        });

        Object.keys(peerConnections.current).forEach((peerId) => {
          if (!next[peerId]) closePeerConnection(peerId);
        });
      }
    );

    const signalsQuery = query(
      collection(db, 'rooms', roomId, 'signals'),
      where('to', '==', currentUser.uid)
    );

    const signalsUnsub = onSnapshot(signalsQuery, async (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue;
        const signalDoc = change.doc;
        const signal = signalDoc.data();
        const peerId = signal.from;

        try {
          if (signal.type === 'offer') {
            let pc = peerConnections.current[peerId];
            if (!pc) pc = createPeerConnection(peerId, false);
            if (!pc) continue;

            await pc.setRemoteDescription(new RTCSessionDescription({
              type: 'offer',
              sdp: signal.sdp
            }));

            const queued = candidateQueues.current[peerId] || [];
            for (const candidate of queued) await pc.addIceCandidate(new RTCIceCandidate(candidate));
            candidateQueues.current[peerId] = [];

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await setDoc(doc(collection(db, 'rooms', roomId, 'signals')), {
              from: currentUser.uid,
              to: peerId,
              type: 'answer',
              sdp: answer.sdp,
              createdAt: serverTimestamp()
            });
          }

          if (signal.type === 'answer') {
            const pc = peerConnections.current[peerId];
            if (pc && !pc.currentRemoteDescription) {
              await pc.setRemoteDescription(new RTCSessionDescription({
                type: 'answer',
                sdp: signal.sdp
              }));

              const queued = candidateQueues.current[peerId] || [];
              for (const candidate of queued) await pc.addIceCandidate(new RTCIceCandidate(candidate));
              candidateQueues.current[peerId] = [];
            }
          }

          if (signal.type === 'candidate') {
            const candidate = signal.candidate;
            const pc = peerConnections.current[peerId];
            if (!pc || !pc.remoteDescription) {
              candidateQueues.current[peerId] ||= [];
              candidateQueues.current[peerId].push(candidate);
            } else {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
          }

          await deleteDoc(signalDoc.ref);
        } catch (err) {
          console.error('Signal processing error:', signal.type, err);
        }
      }
    });

    return () => {
      roomUnsub();
      requestsUnsub();
      participantsUnsub();
      signalsUnsub();
    };
  }, [appState, roomId, isHost, currentUser]);

  const handleAllowGuest = async (requestId) => {
    try {
      await updateDoc(doc(db, 'rooms', roomId, 'requests', requestId), { status: 'approved' });
    } catch (err) {
      console.error('Approve failed:', err);
    }
  };

  const handleDenyGuest = async (requestId) => {
    try {
      await updateDoc(doc(db, 'rooms', roomId, 'requests', requestId), { status: 'denied' });
    } catch (err) {
      console.error('Deny failed:', err);
    }
  };

  const toggleMic = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setIsMicOn(track.enabled);
  };

  const toggleCam = () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setIsCamOn(track.enabled);
  };

  const copyInviteLink = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}?room=${roomId}`);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const leaveMeeting = async (reason = '') => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    Object.keys(peerConnections.current).forEach((peerId) => closePeerConnection(peerId));

    if (roomId && currentUser) {
      try { await deleteDoc(doc(db, 'rooms', roomId, 'participants', currentUser.uid)); } catch (_) {}
    }

    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStreams({});
    setConnectionStates({});
    setParticipants({});
    setPendingRequests([]);
    if (reason) setErrorMsg(reason);
    setAppState(reason ? 'ended' : 'home');
    window.history.pushState({}, '', window.location.pathname);
  };

  const handleEndMeeting = async () => {
    if (!isHost || !roomId) return;
    try {
      await updateDoc(doc(db, 'rooms', roomId), { status: 'ended' });
    } catch (err) {
      console.error('End meeting failed:', err);
    }
    await leaveMeeting();
  };

  const totalTiles = 1 + Object.keys(participants).filter((id) => id !== currentUser?.uid).length;
  const gridClass = totalTiles <= 1 ? 'grid-1' : totalTiles === 2 ? 'grid-2' : totalTiles === 3 ? 'grid-3' : 'grid-4';

  return (
    <div>
      {appState === 'home' && (
        <div className="auth-wrapper">
          <div className="card">
            <h1 className="card-title">Minimal Video Meeting</h1>
            <p className="card-subtitle">Invite-only, serverless WebRTC video meetings</p>
            {errorMsg && <div style={{ color: '#ef4444', marginBottom: '1rem', textAlign: 'center' }}>{errorMsg}</div>}
            <form onSubmit={handleCreateMeeting}>
              <div className="form-group">
                <label className="form-label">Your Name</label>
                <input className="input-field" placeholder="e.g. Alice" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={!authReady} required />
              </div>
              <button type="submit" className="btn btn-primary" disabled={!authReady}>{authReady ? 'Create Meeting' : 'Connecting...'}</button>
            </form>
          </div>
        </div>
      )}

      {appState === 'requesting' && (
        <div className="auth-wrapper">
          <div className="card">
            <h1 className="card-title">Join Meeting</h1>
            <p className="card-subtitle">Room ID: <strong>{roomId}</strong></p>
            {errorMsg && <div style={{ color: '#ef4444', marginBottom: '1rem', textAlign: 'center' }}>{errorMsg}</div>}
            <form onSubmit={handleRequestJoin}>
              <div className="form-group">
                <label className="form-label">Your Display Name</label>
                <input className="input-field" placeholder="e.g. Bob" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={!authReady} required />
              </div>
              <button type="submit" className="btn btn-primary" disabled={!authReady}>{authReady ? (isHost ? 'Enter Meeting (Host)' : 'Request to Join') : 'Connecting...'}</button>
            </form>
          </div>
        </div>
      )}

      {appState === 'waiting' && (
        <div className="auth-wrapper"><div className="card status-box"><div className="spinner" /><h2 className="card-title">Waiting for Host...</h2><p className="card-subtitle">The host will review your request shortly.</p></div></div>
      )}

      {appState === 'denied' && (
        <div className="auth-wrapper"><div className="card status-box"><AlertCircle size={48} color="#ef4444" style={{ margin: '0 auto 1rem' }} /><h2 className="card-title">Request Declined</h2><p className="card-subtitle">The host did not admit you into this meeting.</p><button onClick={() => { setAppState('home'); window.history.pushState({}, '', window.location.pathname); }} className="btn btn-secondary">Back to Home</button></div></div>
      )}

      {appState === 'ended' && (
        <div className="auth-wrapper"><div className="card status-box"><h2 className="card-title">Meeting Ended</h2><p className="card-subtitle">{errorMsg || 'This video meeting has finished.'}</p><button onClick={() => { setErrorMsg(''); setAppState('home'); }} className="btn btn-primary">Return to Home</button></div></div>
      )}

      {appState === 'meeting' && (
        <div className="room-container">
          <header className="room-header">
            <div className="room-info">
              <span className="room-badge"><Users size={14} /> Room: {roomId}</span>
              {isHost && <span className="room-badge" style={{ borderColor: '#3b82f6', color: '#60a5fa' }}><ShieldCheck size={14} /> Host</span>}
            </div>
            <button onClick={copyInviteLink} className="invite-btn">{copiedLink ? <Check size={15} /> : <Copy size={15} />}{copiedLink ? 'Copied Invite Link' : 'Copy Invite Link'}</button>
          </header>

          <main className="video-grid-wrapper">
            <div className={`video-grid ${gridClass}`}>
              <ParticipantTile name={`${displayName} (You)`} stream={localStream} isLocal camOn={isCamOn} micOn={isMicOn} status="connected" />

              {Object.entries(participants)
                .filter(([peerId]) => peerId !== currentUser?.uid)
                .map(([peerId, peerInfo]) => (
                  <ParticipantTile
                    key={peerId}
                    name={`${peerInfo.displayName || 'Participant'}${peerInfo.isHost ? ' (Host)' : ''}`}
                    stream={remoteStreams[peerId]?.stream || null}
                    camOn={Boolean(remoteStreams[peerId]?.stream)}
                    micOn
                    status={connectionStates[peerId] || 'waiting'}
                  />
                ))}
            </div>

            {isHost && pendingRequests.length > 0 && (
              <div className="requests-panel">
                <div className="requests-title"><Users size={16} /> Pending Requests ({pendingRequests.length})</div>
                {pendingRequests.map((req) => (
                  <div key={req.id} className="request-item">
                    <span className="request-name">{req.displayName}</span>
                    <div className="request-actions">
                      <button onClick={() => handleAllowGuest(req.id)} className="btn-xs btn-success"><UserCheck size={14} /> Allow</button>
                      <button onClick={() => handleDenyGuest(req.id)} className="btn-xs btn-danger"><UserX size={14} /> Deny</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </main>

          <footer className="room-controls">
            <button onClick={toggleMic} className={`btn btn-icon ${isMicOn ? 'btn-secondary' : 'active-off'}`} title={isMicOn ? 'Mute Mic' : 'Unmute Mic'}>{isMicOn ? <Mic size={20} /> : <MicOff size={20} />}</button>
            <button onClick={toggleCam} className={`btn btn-icon ${isCamOn ? 'btn-secondary' : 'active-off'}`} title={isCamOn ? 'Turn Off Camera' : 'Turn On Camera'}>{isCamOn ? <VideoIcon size={20} /> : <VideoOff size={20} />}</button>
            <button onClick={() => leaveMeeting()} className="btn btn-icon btn-danger" title="Leave Call"><PhoneOff size={20} /></button>
            {isHost && <button onClick={handleEndMeeting} className="btn btn-danger" style={{ width: 'auto', padding: '0.65rem 1.25rem' }}>End Meeting</button>}
          </footer>
        </div>
      )}
    </div>
  );
}

function ParticipantTile({ name, stream, isLocal = false, camOn = true, micOn = true, status = 'waiting' }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    const play = () => video.play().catch(() => {});
    if (video.readyState >= 2) play();
    else video.onloadedmetadata = play;
    return () => { video.onloadedmetadata = null; };
  }, [stream]);

  const initial = name?.replace(' (You)', '').charAt(0).toUpperCase() || 'P';
  const showVideo = Boolean(stream) && camOn;

  return (
    <div className="video-card" style={{ position: 'relative' }}>
      {showVideo ? (
        <video ref={videoRef} autoPlay playsInline muted={isLocal} className={`video-element ${isLocal ? 'video-mirror' : ''}`} />
      ) : (
        <div className="avatar-placeholder">
          <div className="avatar-circle">{initial}</div>
        </div>
      )}
      <div className="participant-badge">
        <span>{name}</span>
        {!micOn && <MicOff size={13} color="#ef4444" />}
      </div>
      {!isLocal && !stream && (
        <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,.6)', borderRadius: 8, padding: '4px 8px', fontSize: 12 }}>
          {status === 'failed' ? 'Connection failed' : status === 'connected' ? 'Camera off' : 'Connecting…'}
        </div>
      )}
    </div>
  );
}
