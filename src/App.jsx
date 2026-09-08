import React, { useState, useEffect, useRef } from 'react';
import {
  collection,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp
} from 'firebase/firestore';
import { db, initAuth } from './firebase';
import { ICE_SERVERS, generateRoomId } from './webrtc';
import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  PhoneOff,
  Copy,
  Check,
  Users,
  ShieldCheck,
  UserCheck,
  UserX,
  AlertCircle
} from 'lucide-react';

export default function App() {
  // Auth state
  const [currentUser, setCurrentUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  // Navigation & Room state
  const [roomId, setRoomId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [appState, setAppState] = useState('home'); // 'home' | 'requesting' | 'waiting' | 'denied' | 'meeting' | 'ended'

  // Media state
  const [localStream, setLocalStream] = useState(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isCamOn, setIsCamOn] = useState(true);
  const [remoteStreams, setRemoteStreams] = useState({}); // { [peerId]: { stream } }
  const [participants, setParticipants] = useState({});

  // Host state
  const [pendingRequests, setPendingRequests] = useState([]);
  const [copiedLink, setCopiedLink] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // WebRTC refs
  const peerConnections = useRef({}); // { [peerId]: RTCPeerConnection }
  const candidateQueues = useRef({}); // { [peerId]: [candidate] }
  const localStreamRef = useRef(null);

  // 1. Silent anonymous authentication & URL param parsing on startup
  useEffect(() => {
    initAuth()
      .then((user) => {
        setCurrentUser(user);
        setAuthReady(true);

        const params = new URLSearchParams(window.location.search);
        const roomParam = params.get('room');
        if (roomParam) {
          const formattedRoom = roomParam.toLowerCase().trim();
          setRoomId(formattedRoom);

          // Check if this user is the host returning to their room
          getDoc(doc(db, 'rooms', formattedRoom))
            .then((snap) => {
              if (snap.exists()) {
                const roomData = snap.data();
                if (roomData.hostUid === user.uid) {
                  setIsHost(true);
                }
              }
              setAppState('requesting');
            })
            .catch(() => {
              setAppState('requesting');
            });
        }
      })
      .catch((err) => {
        console.error('Silent auth error:', err);
        setErrorMsg('Authentication error. Ensure Anonymous Auth is enabled in Firebase Console.');
      });
  }, []);

  // 2. Host creates a new meeting
  const handleCreateMeeting = async (e) => {
    e.preventDefault();
    if (!displayName.trim() || !currentUser) return;
    setErrorMsg('');

    try {
      const newRoomId = generateRoomId();

      // Create room with host's authenticated anonymous UID
      await setDoc(doc(db, 'rooms', newRoomId), {
        status: 'active',
        hostUid: currentUser.uid,
        createdAt: serverTimestamp()
      });

      setRoomId(newRoomId);
      setIsHost(true);
      window.history.pushState({}, '', `?room=${newRoomId}`);
      await startMeetingRoom(newRoomId, displayName.trim(), true);
    } catch (err) {
      console.error('Error creating meeting:', err);
      setErrorMsg('Failed to create meeting. Check Firestore rules & config.');
    }
  };

  // 3. Guest submits join request
  const handleRequestJoin = async (e) => {
    e.preventDefault();
    if (!displayName.trim() || !roomId.trim() || !currentUser) return;
    setErrorMsg('');

    const targetRoomId = roomId.trim();

    try {
      // Submit join request keyed by guest's own anonymous UID
      // (Firestore rules verify room existence & active status on create)
      const requestRef = doc(db, 'rooms', targetRoomId, 'requests', currentUser.uid);
      await setDoc(requestRef, {
        displayName: displayName.trim(),
        status: 'pending',
        createdAt: serverTimestamp()
      });

      setAppState('waiting');

      // Listen for host decision on guest's request document
      const unsub = onSnapshot(requestRef, async (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          if (data.status === 'approved') {
            unsub();
            await startMeetingRoom(targetRoomId, displayName.trim(), false);
          } else if (data.status === 'denied') {
            unsub();
            setAppState('denied');
          }
        }
      });
    } catch (err) {
      console.error('Error requesting join:', err);
      setErrorMsg('Meeting does not exist, has ended, or join request was blocked.');
    }
  };

  // 4. Enter and initialize WebRTC stream + Firestore participant record
  const startMeetingRoom = async (activeRoomId, name, hostFlag) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      });
      setLocalStream(stream);
      localStreamRef.current = stream;

      // Add self to room's participants collection
      const selfRef = doc(db, 'rooms', activeRoomId, 'participants', currentUser.uid);
      await setDoc(selfRef, {
        participantId: currentUser.uid,
        displayName: name,
        isHost: hostFlag,
        joinedAt: serverTimestamp()
      });

      setAppState('meeting');
    } catch (err) {
      console.error('Media permission failed:', err);
      setErrorMsg('Camera and microphone permission required to join.');
    }
  };

  // 5. Active meeting room realtime subscriptions & WebRTC mesh signaling
  useEffect(() => {
    if (appState !== 'meeting' || !roomId || !currentUser) return;

    // A. Listen to room status (e.g. host ended meeting)
    const roomUnsub = onSnapshot(doc(db, 'rooms', roomId), (snap) => {
      if (snap.exists() && snap.data().status === 'ended') {
        leaveMeeting('Meeting ended by host.');
      }
    });

    // B. Host listens to pending guest join requests
    let requestsUnsub = () => {};
    if (isHost) {
      const q = query(
        collection(db, 'rooms', roomId, 'requests'),
        where('status', '==', 'pending')
      );
      requestsUnsub = onSnapshot(q, (snapshot) => {
        const reqs = [];
        snapshot.forEach((d) => reqs.push({ id: d.id, ...d.data() }));
        setPendingRequests(reqs);
      });
    }

    // C. Listen to all participants in this meeting
    const participantsUnsub = onSnapshot(
      collection(db, 'rooms', roomId, 'participants'),
      (snapshot) => {
        const currentParticipants = {};
        snapshot.forEach((d) => {
          currentParticipants[d.id] = d.data();
        });
        setParticipants(currentParticipants);

        // Deterministic WebRTC connection initiator: higher UID creates offer
        Object.keys(currentParticipants).forEach((peerId) => {
          if (peerId !== currentUser.uid) {
            if (currentUser.uid > peerId && !peerConnections.current[peerId]) {
              initiatePeerConnection(peerId, true);
            }
          }
        });

        // Clean up connections for participants who left
        Object.keys(peerConnections.current).forEach((peerId) => {
          if (!currentParticipants[peerId]) {
            closePeerConnection(peerId);
          }
        });
      }
    );

    // D. Listen to incoming WebRTC signaling messages targeted to this user
    const signalsQuery = query(
      collection(db, 'rooms', roomId, 'signals'),
      where('to', '==', currentUser.uid)
    );

    const signalsUnsub = onSnapshot(signalsQuery, async (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
          const signalDoc = change.doc;
          const signal = signalDoc.data();
          const fromPeerId = signal.from;

          try {
            if (signal.type === 'offer') {
              const pc = initiatePeerConnection(fromPeerId, false);
              await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));

              // Drain any queued ICE candidates
              if (candidateQueues.current[fromPeerId]) {
                for (const candidate of candidateQueues.current[fromPeerId]) {
                  await pc.addIceCandidate(new RTCIceCandidate(candidate));
                }
                candidateQueues.current[fromPeerId] = [];
              }

              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);

              // Post answer back to Firestore
              await setDoc(doc(collection(db, 'rooms', roomId, 'signals')), {
                from: currentUser.uid,
                to: fromPeerId,
                type: 'answer',
                sdp: answer.sdp,
                createdAt: serverTimestamp()
              });
            } else if (signal.type === 'answer') {
              const pc = peerConnections.current[fromPeerId];
              if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));

                if (candidateQueues.current[fromPeerId]) {
                  for (const candidate of candidateQueues.current[fromPeerId]) {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                  }
                  candidateQueues.current[fromPeerId] = [];
                }
              }
            } else if (signal.type === 'candidate') {
              const pc = peerConnections.current[fromPeerId];
              const candidate = signal.candidate;
              if (pc && pc.remoteDescription && pc.remoteDescription.type) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
              } else {
                if (!candidateQueues.current[fromPeerId]) candidateQueues.current[fromPeerId] = [];
                candidateQueues.current[fromPeerId].push(candidate);
              }
            }

            // Immediately delete consumed signaling doc to keep Firestore free tier usage near zero
            await deleteDoc(signalDoc.ref);
          } catch (err) {
            console.error('Signal processing error:', err);
          }
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

  // PeerConnection factory
  const initiatePeerConnection = (peerId, isOfferInitiator) => {
    if (peerConnections.current[peerId]) {
      return peerConnections.current[peerId];
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnections.current[peerId] = pc;

    // Attach local media tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    // Handle remote media stream
    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStreams((prev) => ({
          ...prev,
          [peerId]: {
            stream: event.streams[0]
          }
        }));
      }
    };

    // Emit local ICE candidate to Firestore
    pc.onicecandidate = async (event) => {
      if (event.candidate && currentUser) {
        try {
          await setDoc(doc(collection(db, 'rooms', roomId, 'signals')), {
            from: currentUser.uid,
            to: peerId,
            type: 'candidate',
            candidate: event.candidate.toJSON(),
            createdAt: serverTimestamp()
          });
        } catch (err) {
          console.error('Failed to send ICE candidate:', err);
        }
      }
    };

    // If initiator, generate SDP offer
    if (isOfferInitiator) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(async () => {
          await setDoc(doc(collection(db, 'rooms', roomId, 'signals')), {
            from: currentUser.uid,
            to: peerId,
            type: 'offer',
            sdp: pc.localDescription.sdp,
            createdAt: serverTimestamp()
          });
        })
        .catch((err) => console.error('Error creating offer:', err));
    }

    return pc;
  };

  const closePeerConnection = (peerId) => {
    if (peerConnections.current[peerId]) {
      peerConnections.current[peerId].close();
      delete peerConnections.current[peerId];
    }
    setRemoteStreams((prev) => {
      const copy = { ...prev };
      delete copy[peerId];
      return copy;
    });
  };

  // Host allows guest
  const handleAllowGuest = async (requestId) => {
    try {
      await updateDoc(doc(db, 'rooms', roomId, 'requests', requestId), {
        status: 'approved'
      });
    } catch (err) {
      console.error('Failed to approve guest:', err);
    }
  };

  // Host denies guest
  const handleDenyGuest = async (requestId) => {
    try {
      await updateDoc(doc(db, 'rooms', roomId, 'requests', requestId), {
        status: 'denied'
      });
    } catch (err) {
      console.error('Failed to deny guest:', err);
    }
  };

  // Media toggles
  const toggleMic = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMicOn(audioTrack.enabled);
      }
    }
  };

  const toggleCam = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsCamOn(videoTrack.enabled);
      }
    }
  };

  // Copy invite link
  const copyInviteLink = () => {
    const inviteUrl = `${window.location.origin}?room=${roomId}`;
    navigator.clipboard.writeText(inviteUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  // Leave meeting
  const leaveMeeting = async (reason = '') => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
    }

    Object.keys(peerConnections.current).forEach((peerId) => {
      closePeerConnection(peerId);
    });

    if (roomId && currentUser) {
      try {
        await deleteDoc(doc(db, 'rooms', roomId, 'participants', currentUser.uid));
      } catch (e) {
        // Ignored on teardown
      }
    }

    setLocalStream(null);
    localStreamRef.current = null;
    setRemoteStreams({});
    if (reason) setErrorMsg(reason);
    setAppState(reason ? 'ended' : 'home');
    window.history.pushState({}, '', window.location.pathname);
  };

  // Host ends meeting for everyone
  const handleEndMeeting = async () => {
    if (!isHost || !roomId) return;
    try {
      await updateDoc(doc(db, 'rooms', roomId), {
        status: 'ended'
      });
      leaveMeeting();
    } catch (err) {
      console.error('Error ending meeting:', err);
      leaveMeeting();
    }
  };

  const totalTiles = 1 + Object.keys(remoteStreams).length;
  const gridClass = totalTiles <= 1 ? 'grid-1' : totalTiles === 2 ? 'grid-2' : totalTiles === 3 ? 'grid-3' : 'grid-4';

  return (
    <div>
      {/* 1. HOME SCREEN */}
      {appState === 'home' && (
        <div className="auth-wrapper">
          <div className="card">
            <h1 className="card-title">Minimal Video Meeting</h1>
            <p className="card-subtitle">Invite-only, serverless WebRTC video meetings</p>

            {errorMsg && (
              <div style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem', textAlign: 'center' }}>
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleCreateMeeting}>
              <div className="form-group">
                <label className="form-label">Your Name</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="e.g. Alice"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={!authReady}
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={!authReady}>
                {authReady ? 'Create Meeting' : 'Connecting...'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 2. GUEST JOIN / REQUEST SCREEN */}
      {appState === 'requesting' && (
        <div className="auth-wrapper">
          <div className="card">
            <h1 className="card-title">Join Meeting</h1>
            <p className="card-subtitle">Room ID: <strong>{roomId}</strong></p>

            {errorMsg && (
              <div style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem', textAlign: 'center' }}>
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleRequestJoin}>
              <div className="form-group">
                <label className="form-label">Your Display Name</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="e.g. Bob"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={!authReady}
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={!authReady}>
                {authReady ? (isHost ? 'Enter Meeting (Host)' : 'Request to Join') : 'Connecting...'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 3. WAITING FOR APPROVAL SCREEN */}
      {appState === 'waiting' && (
        <div className="auth-wrapper">
          <div className="card status-box">
            <div className="spinner"></div>
            <h2 className="card-title">Waiting for Host...</h2>
            <p className="card-subtitle">The host will review your request shortly.</p>
          </div>
        </div>
      )}

      {/* 4. REQUEST DENIED SCREEN */}
      {appState === 'denied' && (
        <div className="auth-wrapper">
          <div className="card status-box">
            <AlertCircle size={48} color="#ef4444" style={{ margin: '0 auto 1rem auto' }} />
            <h2 className="card-title">Request Declined</h2>
            <p className="card-subtitle">The host did not admit you into this meeting.</p>
            <button
              onClick={() => {
                setAppState('home');
                window.history.pushState({}, '', window.location.pathname);
              }}
              className="btn btn-secondary"
            >
              Back to Home
            </button>
          </div>
        </div>
      )}

      {/* 5. MEETING ENDED SCREEN */}
      {appState === 'ended' && (
        <div className="auth-wrapper">
          <div className="card status-box">
            <h2 className="card-title">Meeting Ended</h2>
            <p className="card-subtitle">{errorMsg || 'This video meeting has finished.'}</p>
            <button
              onClick={() => {
                setErrorMsg('');
                setAppState('home');
              }}
              className="btn btn-primary"
            >
              Return to Home
            </button>
          </div>
        </div>
      )}

      {/* 6. ACTIVE MEETING ROOM */}
      {appState === 'meeting' && (
        <div className="room-container">
          <header className="room-header">
            <div className="room-info">
              <span className="room-badge">
                <Users size={14} /> Room: {roomId}
              </span>
              {isHost && (
                <span className="room-badge" style={{ borderColor: '#3b82f6', color: '#60a5fa' }}>
                  <ShieldCheck size={14} /> Host
                </span>
              )}
            </div>

            <button onClick={copyInviteLink} className="invite-btn">
              {copiedLink ? <Check size={15} color="#4ade80" /> : <Copy size={15} />}
              {copiedLink ? 'Copied Invite Link' : 'Copy Invite Link'}
            </button>
          </header>

          <main className="video-grid-wrapper">
            <div className={`video-grid ${gridClass}`}>
              {/* Local Participant Tile */}
              <div className="video-card">
                {isCamOn && localStream ? (
                  <VideoTile stream={localStream} isLocal={true} />
                ) : (
                  <div className="avatar-placeholder">
                    <div className="avatar-circle">
                      {displayName ? displayName[0].toUpperCase() : 'U'}
                    </div>
                  </div>
                )}
                <div className="participant-badge">
                  <span>{displayName} (You)</span>
                  {!isMicOn && <MicOff size={13} color="#ef4444" />}
                </div>
              </div>

              {/* Remote Participants Tiles */}
              {Object.entries(remoteStreams).map(([peerId, data]) => {
                const peerInfo = participants[peerId] || {};
                return (
                  <div key={peerId} className="video-card">
                    {data.stream ? (
                      <VideoTile stream={data.stream} isLocal={false} />
                    ) : (
                      <div className="avatar-placeholder">
                        <div className="avatar-circle">
                          {peerInfo.displayName ? peerInfo.displayName[0].toUpperCase() : 'P'}
                        </div>
                      </div>
                    )}
                    <div className="participant-badge">
                      <span>{peerInfo.displayName || 'Participant'}</span>
                      {peerInfo.isHost && (
                        <span style={{ color: '#60a5fa', marginLeft: '4px', fontSize: '0.75rem' }}>(Host)</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Host Floating Pending Requests Panel */}
            {isHost && pendingRequests.length > 0 && (
              <div className="requests-panel">
                <div className="requests-title">
                  <Users size={16} /> Pending Requests ({pendingRequests.length})
                </div>
                {pendingRequests.map((req) => (
                  <div key={req.id} className="request-item">
                    <span className="request-name">{req.displayName}</span>
                    <div className="request-actions">
                      <button
                        onClick={() => handleAllowGuest(req.id)}
                        className="btn-xs btn-success"
                        title="Allow"
                      >
                        <UserCheck size={14} /> Allow
                      </button>
                      <button
                        onClick={() => handleDenyGuest(req.id)}
                        className="btn-xs btn-danger"
                        title="Deny"
                      >
                        <UserX size={14} /> Deny
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </main>

          <footer className="room-controls">
            <button
              onClick={toggleMic}
              className={`btn btn-icon ${isMicOn ? 'btn-secondary' : 'active-off'}`}
              title={isMicOn ? 'Mute Mic' : 'Unmute Mic'}
            >
              {isMicOn ? <Mic size={20} /> : <MicOff size={20} />}
            </button>

            <button
              onClick={toggleCam}
              className={`btn btn-icon ${isCamOn ? 'btn-secondary' : 'active-off'}`}
              title={isCamOn ? 'Turn Off Camera' : 'Turn On Camera'}
            >
              {isCamOn ? <VideoIcon size={20} /> : <VideoOff size={20} />}
            </button>

            <button
              onClick={() => leaveMeeting()}
              className="btn btn-icon btn-danger"
              title="Leave Call"
            >
              <PhoneOff size={20} />
            </button>

            {isHost && (
              <button
                onClick={handleEndMeeting}
                className="btn btn-danger"
                style={{ width: 'auto', padding: '0.65rem 1.25rem' }}
              >
                End Meeting
              </button>
            )}
          </footer>
        </div>
      )}
    </div>
  );
}

function VideoTile({ stream, isLocal }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={isLocal}
      className={`video-element ${isLocal ? 'video-mirror' : ''}`}
    />
  );
}
