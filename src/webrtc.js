// Public free STUN servers
export const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// Generate a random room ID (e.g. abc-def-ghi)
export function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const segment = (len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${segment(3)}-${segment(3)}-${segment(3)}`;
}
