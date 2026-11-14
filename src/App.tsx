import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageSquare,
  Phone,
  Search,
  UserPlus,
  Users,
  Video,
} from 'lucide-react';
import { AuthScreen } from './components/AuthScreen.tsx';
import { Avatar } from './components/Avatar.tsx';
import { CallStage } from './components/CallStage.tsx';
import { CallsView } from './components/CallsView.tsx';
import { ChatView } from './components/ChatView.tsx';
import { FriendsView } from './components/FriendsView.tsx';
import { ProfileModal } from './components/ProfileModal.tsx';
import { apiRequest, getStoredToken, setStoredToken } from './lib/api.ts';
import {
  playMessageCue,
  startIncomingRingtone,
  startOutgoingRingback,
  stopCallTones,
} from './lib/sound.ts';
import type {
  ActiveCallSession,
  CallLogItem,
  CallType,
  ChatMessage,
  FriendItem,
  FriendRequestItem,
  PublicUser,
} from './types.ts';

type WorkspaceTab = 'messages' | 'friends' | 'calls';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function createSilentFallbackStream(): MediaStream {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    return dest.stream;
  } catch {
    return new MediaStream();
  }
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [token, setToken] = useState<string | null>(() => getStoredToken());

  const [tab, setTab] = useState<WorkspaceTab>('messages');
  const [friends, setFriends] = useState<FriendItem[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<FriendRequestItem[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<FriendRequestItem[]>([]);
  const [calls, setCalls] = useState<CallLogItem[]>([]);

  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null);
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [messagesByFriend, setMessagesByFriend] = useState<Record<string, ChatMessage[]>>({});
  const [loadingMessagesFor, setLoadingMessagesFor] = useState<string | null>(null);
  const [typingUsers, setTypingUsers] = useState<Record<string, boolean>>({});

  const [showProfileModal, setShowProfileModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // WebRTC & Call state
  const [incomingCall, setIncomingCall] = useState<{
    callId: string;
    caller: PublicUser;
    callType: CallType;
  } | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCallSession | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const activeCallRef = useRef<ActiveCallSession | null>(null);
  const incomingCallRef = useRef<typeof incomingCall>(null);
  const selectedFriendIdRef = useRef<string | null>(null);
  const tabRef = useRef<WorkspaceTab>('messages');
  const userRef = useRef<PublicUser | null>(null);
  const typingTimeoutsRef = useRef<Record<string, number>>({});

  useEffect(() => {
    document.documentElement.classList.remove('dark');
  }, []);

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  useEffect(() => {
    selectedFriendIdRef.current = selectedFriendId;
  }, [selectedFriendId]);

  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 3600);
  }, []);

  const sendWs = useCallback((event: string, payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, payload }));
    }
  }, []);

  const refreshFriends = useCallback(async () => {
    try {
      const data = await apiRequest<{
        friends: FriendItem[];
        incomingRequests: FriendRequestItem[];
        outgoingRequests: FriendRequestItem[];
      }>('/api/friends');
      setFriends(data.friends);
      setIncomingRequests(data.incomingRequests);
      setOutgoingRequests(data.outgoingRequests);
    } catch {
      // ignore transient error
    }
  }, []);

  const refreshCalls = useCallback(async () => {
    try {
      const data = await apiRequest<{ calls: CallLogItem[] }>('/api/calls');
      setCalls(data.calls);
    } catch {
      // ignore transient error
    }
  }, []);

  const loadMessages = useCallback(async (friendId: string) => {
    setLoadingMessagesFor(friendId);
    try {
      const data = await apiRequest<{ messages: ChatMessage[] }>(`/api/messages/${friendId}`);
      setMessagesByFriend((prev) => ({
        ...prev,
        [friendId]: data.messages,
      }));
      setFriends((prev) =>
        prev.map((f) => (f.id === friendId ? { ...f, unreadCount: 0 } : f))
      );
    } finally {
      setLoadingMessagesFor((cur) => (cur === friendId ? null : cur));
    }
  }, []);

  const cleanupCallMedia = useCallback(() => {
    stopCallTones();
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {
        // ignore
      }
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop();
      }
      localStreamRef.current = null;
    }
    pendingIceRef.current = [];
    setLocalStream(null);
    setRemoteStream(null);
    setActiveCall(null);
  }, []);

  const acquireMedia = useCallback(
    async (
      callType: CallType
    ): Promise<{ stream: MediaStream; audio: boolean; video: boolean; notice: string | null }> => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return {
          stream: createSilentFallbackStream(),
          audio: false,
          video: false,
          notice: 'Browser media devices unavailable — connected in listen-only mode.',
        };
      }

      if (callType === 'video') {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
          return { stream, audio: true, video: true, notice: null };
        } catch {
          try {
            const audioStream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: false,
            });
            return {
              stream: audioStream,
              audio: true,
              video: false,
              notice: 'Camera unavailable — continuing with voice only.',
            };
          } catch {
            return {
              stream: createSilentFallbackStream(),
              audio: false,
              video: false,
              notice: 'Microphone and camera unavailable — connected in listen-only mode.',
            };
          }
        }
      }

      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        return { stream: audioStream, audio: true, video: false, notice: null };
      } catch {
        return {
          stream: createSilentFallbackStream(),
          audio: false,
          video: false,
          notice: 'Microphone unavailable — connected in listen-only mode.',
        };
      }
    },
    []
  );

  const createPeerConnection = useCallback(
    (callId: string, peerId: string, stream: MediaStream): RTCPeerConnection => {
      const pc = new RTCPeerConnection(ICE_SERVERS);
      const inboundStream = new MediaStream();
      setRemoteStream(inboundStream);

      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          setRemoteStream(event.streams[0]);
        } else {
          inboundStream.addTrack(event.track);
          setRemoteStream(new MediaStream(inboundStream.getTracks()));
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendWs('call:ice-candidate', {
            callId,
            toUserId: peerId,
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setActiveCall((cur) =>
            cur && cur.callId === callId
              ? { ...cur, phase: 'connected', connectedAt: cur.connectedAt || Date.now() }
              : cur
          );
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          setActiveCall((cur) =>
            cur && cur.callId === callId
              ? { ...cur, phase: 'connected', connectedAt: cur.connectedAt || Date.now() }
              : cur
          );
        }
      };

      pcRef.current = pc;
      return pc;
    },
    [sendWs]
  );

  // Boot session check
  useEffect(() => {
    let active = true;
    async function init() {
      const stored = getStoredToken();
      if (!stored) {
        if (active) setBooting(false);
        return;
      }
      try {
        const data = await apiRequest<{ user: PublicUser }>('/api/auth/me');
        if (active) {
          setUser(data.user);
          setToken(stored);
        }
      } catch {
        setStoredToken(null);
        if (active) {
          setUser(null);
          setToken(null);
        }
      } finally {
        if (active) setBooting(false);
      }
    }
    void init();
    return () => {
      active = false;
    };
  }, []);

  // Load initial data + maintain WebSocket connection when authenticated
  useEffect(() => {
    if (!user || !token) return;

    void refreshFriends();
    void refreshCalls();

    let closedIntentionally = false;
    let reconnectTimer: number | null = null;
    let backoffMs = 800;

    function connect() {
      if (closedIntentionally) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token!)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        backoffMs = 800;
        void refreshFriends();
        void refreshCalls();
      };

      ws.onmessage = async (evt) => {
        let parsed: { event?: string; payload?: Record<string, unknown> };
        try {
          parsed = JSON.parse(evt.data as string) as {
            event?: string;
            payload?: Record<string, unknown>;
          };
        } catch {
          return;
        }
        const { event, payload = {} } = parsed;
        if (!event) return;

        if (event === 'presence:update') {
          const uid = payload.userId as string;
          const online = Boolean(payload.online);
          const inCall = Boolean(payload.inCall);
          setFriends((prev) =>
            prev.map((f) => (f.id === uid ? { ...f, online, inCall } : f))
          );
          return;
        }

        if (event === 'friends:updated') {
          if (payload.fromUser) {
            const fromUser = payload.fromUser as PublicUser;
            showToast(`Friend request from @${fromUser.username}`);
          }
          void refreshFriends();
          return;
        }

        if (event === 'calls:updated') {
          void refreshCalls();
          return;
        }

        if (event === 'typing:start' || event === 'typing:stop') {
          const fromId = payload.fromUserId as string;
          if (!fromId) return;
          if (typingTimeoutsRef.current[fromId]) {
            window.clearTimeout(typingTimeoutsRef.current[fromId]);
          }
          if (event === 'typing:start') {
            setTypingUsers((prev) => ({ ...prev, [fromId]: true }));
            typingTimeoutsRef.current[fromId] = window.setTimeout(() => {
              setTypingUsers((prev) => ({ ...prev, [fromId]: false }));
            }, 3000);
          } else {
            setTypingUsers((prev) => ({ ...prev, [fromId]: false }));
          }
          return;
        }

        if (event === 'messages:read') {
          const byUserId = payload.byUserId as string;
          if (!byUserId) return;
          setMessagesByFriend((prev) => {
            const list = prev[byUserId];
            if (!list) return prev;
            const now = Date.now();
            return {
              ...prev,
              [byUserId]: list.map((m) =>
                m.senderId === userRef.current?.id && !m.readAt ? { ...m, readAt: now } : m
              ),
            };
          });
          return;
        }

        if (event === 'message:new') {
          const msg = payload.message as ChatMessage;
          if (!msg || !userRef.current) return;
          const meId = userRef.current.id;
          const peerId = msg.senderId === meId ? msg.recipientId : msg.senderId;
          const isCurrentlyViewing =
            tabRef.current === 'messages' && selectedFriendIdRef.current === peerId;

          if (msg.senderId !== meId && msg.kind === 'text') {
            playMessageCue();
            if (isCurrentlyViewing) {
              sendWs('messages:mark_read', { friendId: peerId });
            }
          }

          setMessagesByFriend((prev) => {
            const existing = prev[peerId] || [];
            if (existing.some((m) => m.id === msg.id)) return prev;
            return { ...prev, [peerId]: [...existing, msg] };
          });

          setFriends((prev) => {
            const updated = prev.map((f) => {
              if (f.id !== peerId) return f;
              const incUnread =
                msg.senderId !== meId && !isCurrentlyViewing ? f.unreadCount + 1 : f.unreadCount;
              return { ...f, lastMessage: msg, unreadCount: incUnread };
            });
            updated.sort((a, b) => {
              const at = a.lastMessage?.createdAt ?? a.createdAt;
              const bt = b.lastMessage?.createdAt ?? b.createdAt;
              return bt - at;
            });
            return updated;
          });
          return;
        }

        if (event === 'message:updated') {
          const msg = payload.message as ChatMessage;
          if (!msg || !userRef.current) return;
          const peerId = msg.senderId === userRef.current.id ? msg.recipientId : msg.senderId;
          setMessagesByFriend((prev) => {
            const list = prev[peerId];
            if (!list) return prev;
            return {
              ...prev,
              [peerId]: list.map((m) => (m.id === msg.id ? msg : m)),
            };
          });
          return;
        }

        if (event === 'message:deleted') {
          const messageId = payload.messageId as string;
          if (!messageId) return;
          setMessagesByFriend((prev) => {
            const next: Record<string, ChatMessage[]> = {};
            for (const [fid, list] of Object.entries(prev)) {
              next[fid] = list.filter((m) => m.id !== messageId);
            }
            return next;
          });
          return;
        }

        // --- WebRTC Call Signaling ---
        if (event === 'call:incoming') {
          const callId = payload.callId as string;
          const callType = (payload.callType as CallType) || 'voice';
          const caller = payload.caller as PublicUser;
          if (activeCallRef.current || incomingCallRef.current) {
            sendWs('call:decline', { callId, toUserId: caller.id });
            return;
          }
          startIncomingRingtone();
          setIncomingCall({ callId, caller, callType });
          return;
        }

        if (event === 'call:unavailable' || event === 'call:error') {
          const reason = (payload.reason as string) || 'Call unavailable.';
          cleanupCallMedia();
          showToast(reason);
          void refreshCalls();
          return;
        }

        if (event === 'call:declined') {
          cleanupCallMedia();
          showToast('Call was declined.');
          void refreshCalls();
          return;
        }

        if (event === 'call:ended') {
          if (incomingCallRef.current && incomingCallRef.current.callId === payload.callId) {
            stopCallTones();
            setIncomingCall(null);
          }
          if (activeCallRef.current && activeCallRef.current.callId === payload.callId) {
            cleanupCallMedia();
            showToast('Call ended.');
          }
          void refreshCalls();
          return;
        }

        if (event === 'call:accepted') {
          const cur = activeCallRef.current;
          const callId = payload.callId as string;
          if (!cur || cur.callId !== callId) return;
          stopCallTones();
          setActiveCall((prev) => (prev ? { ...prev, phase: 'connecting' } : prev));
          const stream = localStreamRef.current || createSilentFallbackStream();
          const pc = createPeerConnection(callId, cur.peer.id, stream);
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendWs('call:offer', { callId, toUserId: cur.peer.id, sdp: offer });
          } catch {
            showToast('Failed to negotiate call.');
            cleanupCallMedia();
          }
          return;
        }

        if (event === 'call:offer') {
          const callId = payload.callId as string;
          const fromUserId = payload.fromUserId as string;
          const sdp = payload.sdp as RTCSessionDescriptionInit;
          const pc = pcRef.current;
          if (!pc || !activeCallRef.current || activeCallRef.current.callId !== callId) return;
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            for (const cand of pendingIceRef.current) {
              await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
            }
            pendingIceRef.current = [];
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendWs('call:answer', { callId, toUserId: fromUserId, sdp: answer });
            setActiveCall((prev) =>
              prev
                ? { ...prev, phase: 'connected', connectedAt: prev.connectedAt || Date.now() }
                : prev
            );
          } catch {
            showToast('Failed to answer call.');
            cleanupCallMedia();
          }
          return;
        }

        if (event === 'call:answer') {
          const callId = payload.callId as string;
          const sdp = payload.sdp as RTCSessionDescriptionInit;
          const pc = pcRef.current;
          if (!pc || !activeCallRef.current || activeCallRef.current.callId !== callId) return;
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            for (const cand of pendingIceRef.current) {
              await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
            }
            pendingIceRef.current = [];
            setActiveCall((prev) =>
              prev
                ? { ...prev, phase: 'connected', connectedAt: prev.connectedAt || Date.now() }
                : prev
            );
          } catch {
            // ignore
          }
          return;
        }

        if (event === 'call:ice-candidate') {
          const callId = payload.callId as string;
          const candidate = payload.candidate as RTCIceCandidateInit;
          const pc = pcRef.current;
          if (!pc || !activeCallRef.current || activeCallRef.current.callId !== callId) return;
          if (pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
          } else {
            pendingIceRef.current.push(candidate);
          }
          return;
        }

        if (event === 'call:media-state') {
          const callId = payload.callId as string;
          if (!activeCallRef.current || activeCallRef.current.callId !== callId) return;
          setActiveCall((prev) =>
            prev
              ? {
                  ...prev,
                  peerAudioEnabled:
                    typeof payload.audioEnabled === 'boolean'
                      ? payload.audioEnabled
                      : prev.peerAudioEnabled,
                  peerVideoEnabled:
                    typeof payload.videoEnabled === 'boolean'
                      ? payload.videoEnabled
                      : prev.peerVideoEnabled,
                }
              : prev
          );
        }
      };

      ws.onclose = () => {
        if (closedIntentionally) return;
        reconnectTimer = window.setTimeout(() => {
          backoffMs = Math.min(backoffMs * 1.6, 8000);
          connect();
        }, backoffMs);
      };
    }

    connect();

    return () => {
      closedIntentionally = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [
    user?.id,
    token,
    refreshFriends,
    refreshCalls,
    sendWs,
    showToast,
    cleanupCallMedia,
    createPeerConnection,
  ]);

  useEffect(() => {
    if (!selectedFriendId || !user) return;
    void loadMessages(selectedFriendId);
  }, [selectedFriendId, user?.id, loadMessages]);

  const handleAuthenticated = useCallback((authedUser: PublicUser, authedToken: string) => {
    setUser(authedUser);
    setToken(authedToken);
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    cleanupCallMedia();
    setStoredToken(null);
    setUser(null);
    setToken(null);
    setFriends([]);
    setIncomingRequests([]);
    setOutgoingRequests([]);
    setCalls([]);
    setMessagesByFriend({});
    setSelectedFriendId(null);
    setShowProfileModal(false);
  }, [cleanupCallMedia]);

  const handleOpenChat = useCallback((friendId: string) => {
    setSelectedFriendId(friendId);
    setTab('messages');
  }, []);

  const handleStartCall = useCallback(
    async (peer: PublicUser, callType: CallType) => {
      if (activeCallRef.current) {
        showToast('You are already on a call.');
        return;
      }
      const callId = crypto.randomUUID();
      const { stream, audio, video, notice } = await acquireMedia(callType);
      localStreamRef.current = stream;
      setLocalStream(stream);

      const session: ActiveCallSession = {
        callId,
        peer,
        direction: 'outgoing',
        callType,
        phase: 'ringing',
        startedAt: Date.now(),
        connectedAt: null,
        audioEnabled: audio,
        videoEnabled: video,
        peerAudioEnabled: true,
        peerVideoEnabled: callType === 'video',
        mediaNotice: notice,
      };
      setActiveCall(session);
      startOutgoingRingback();
      sendWs('call:invite', { toUserId: peer.id, callType, callId });
    },
    [acquireMedia, sendWs, showToast]
  );

  const handleAcceptIncoming = useCallback(async () => {
    const inc = incomingCallRef.current;
    if (!inc) return;
    stopCallTones();
    setIncomingCall(null);

    const { stream, audio, video, notice } = await acquireMedia(inc.callType);
    localStreamRef.current = stream;
    setLocalStream(stream);

    createPeerConnection(inc.callId, inc.caller.id, stream);

    const session: ActiveCallSession = {
      callId: inc.callId,
      peer: inc.caller,
      direction: 'incoming',
      callType: inc.callType,
      phase: 'connecting',
      startedAt: Date.now(),
      connectedAt: null,
      audioEnabled: audio,
      videoEnabled: video,
      peerAudioEnabled: true,
      peerVideoEnabled: inc.callType === 'video',
      mediaNotice: notice,
    };
    setActiveCall(session);
    sendWs('call:accept', { callId: inc.callId, toUserId: inc.caller.id });
  }, [acquireMedia, createPeerConnection, sendWs]);

  const handleDeclineIncoming = useCallback(() => {
    const inc = incomingCallRef.current;
    if (!inc) return;
    stopCallTones();
    setIncomingCall(null);
    sendWs('call:decline', { callId: inc.callId, toUserId: inc.caller.id });
  }, [sendWs]);

  const handleEndCall = useCallback(() => {
    const cur = activeCallRef.current;
    if (!cur) return;
    sendWs('call:end', { callId: cur.callId, toUserId: cur.peer.id });
    cleanupCallMedia();
    void refreshCalls();
  }, [cleanupCallMedia, refreshCalls, sendWs]);

  const handleToggleAudio = useCallback(() => {
    const cur = activeCallRef.current;
    const stream = localStreamRef.current;
    if (!cur || !stream) return;
    const nextEnabled = !cur.audioEnabled;
    for (const track of stream.getAudioTracks()) {
      track.enabled = nextEnabled;
    }
    setActiveCall((prev) => (prev ? { ...prev, audioEnabled: nextEnabled } : prev));
    sendWs('call:media-state', {
      callId: cur.callId,
      toUserId: cur.peer.id,
      audioEnabled: nextEnabled,
      videoEnabled: cur.videoEnabled,
    });
  }, [sendWs]);

  const handleToggleVideo = useCallback(() => {
    const cur = activeCallRef.current;
    const stream = localStreamRef.current;
    if (!cur || !stream) return;
    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length === 0) {
      showToast('No camera track available for this call.');
      return;
    }
    const nextEnabled = !cur.videoEnabled;
    for (const track of videoTracks) {
      track.enabled = nextEnabled;
    }
    setActiveCall((prev) => (prev ? { ...prev, videoEnabled: nextEnabled } : prev));
    sendWs('call:media-state', {
      callId: cur.callId,
      toUserId: cur.peer.id,
      audioEnabled: cur.audioEnabled,
      videoEnabled: nextEnabled,
    });
  }, [sendWs, showToast]);

  const handleSendMessage = useCallback(
    async (body: string, replyToId?: string | null) => {
      if (!selectedFriendId) return;
      const data = await apiRequest<{ message: ChatMessage }>(`/api/messages/${selectedFriendId}`, {
        method: 'POST',
        body: JSON.stringify({ body, replyToId }),
      });
      setMessagesByFriend((prev) => {
        const list = prev[selectedFriendId] || [];
        if (list.some((m) => m.id === data.message.id)) return prev;
        return { ...prev, [selectedFriendId]: [...list, data.message] };
      });
    },
    [selectedFriendId]
  );

  const handleReactMessage = useCallback(async (messageId: string, emoji: string) => {
    await apiRequest(`/api/messages/${messageId}/react`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    });
  }, []);

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    await apiRequest(`/api/messages/${messageId}`, { method: 'DELETE' });
  }, []);

  const handleRemoveFriend = useCallback(
    async (friendId: string) => {
      await apiRequest(`/api/friends/${friendId}`, { method: 'DELETE' });
      if (selectedFriendId === friendId) {
        setSelectedFriendId(null);
      }
      await refreshFriends();
      showToast('Friend removed.');
    },
    [refreshFriends, selectedFriendId, showToast]
  );

  const onlineMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const f of friends) {
      map[f.id] = f.online;
    }
    return map;
  }, [friends]);

  const filteredFriends = useMemo(() => {
    const q = sidebarSearch.trim().toLowerCase();
    if (!q) return friends;
    return friends.filter(
      (f) => f.username.toLowerCase().includes(q) || f.displayName.toLowerCase().includes(q)
    );
  }, [friends, sidebarSearch]);

  const selectedFriend = useMemo(
    () => friends.find((f) => f.id === selectedFriendId) || null,
    [friends, selectedFriendId]
  );

  const totalUnread = useMemo(
    () => friends.reduce((acc, f) => acc + (f.unreadCount || 0), 0),
    [friends]
  );

  if (booting) {
    return (
      <div className="min-h-screen bg-[#FFFFFF] flex items-center justify-center text-sm text-[#5D6D7E]">
        Loading Chattr...
      </div>
    );
  }

  if (!user) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  const showMobileDetail =
    tab !== 'messages' || (tab === 'messages' && Boolean(selectedFriend));

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#FFFFFF] text-[#283747] flex flex-col md:flex-row">
      {/* Desktop Left Navigation Rail */}
      <nav
        aria-label="Primary navigation"
        className="hidden md:flex w-18 bg-[#F4F6F8] border-r border-[#E6EBF0] text-[#5D6D7E] flex-col items-center py-4 justify-between shrink-0"
      >
        <div className="flex flex-col items-center gap-3 w-full px-2">
          <img
            src="/assets/aistudio/Dusty_Blue_Chat_Bubble_Icon__1__dfe423b3.png"
            alt="Chattr"
            className="w-10 h-10 rounded-xl object-cover mb-3 select-none"
          />

          <button
            type="button"
            onClick={() => setTab('messages')}
            className={`relative w-12 h-12 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
              tab === 'messages'
                ? 'bg-[#FFFFFF] text-[#7895B2] border border-[#E6EBF0]'
                : 'text-[#5D6D7E] hover:text-[#283747] hover:bg-[#FFFFFF]/70'
            }`}
            title="Messages"
            aria-label="Messages"
          >
            <MessageSquare className="w-5 h-5" strokeWidth={1.6} />
            {totalUnread > 0 && (
              <span className="absolute top-1.5 right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#7895B2] text-white font-mono text-[10px] font-semibold flex items-center justify-center tabular-nums">
                {totalUnread > 99 ? '99+' : totalUnread}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setTab('friends')}
            className={`relative w-12 h-12 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
              tab === 'friends'
                ? 'bg-[#FFFFFF] text-[#7895B2] border border-[#E6EBF0]'
                : 'text-[#5D6D7E] hover:text-[#283747] hover:bg-[#FFFFFF]/70'
            }`}
            title="Friends & Add People"
            aria-label="Friends and People"
          >
            <Users className="w-5 h-5" strokeWidth={1.6} />
            {incomingRequests.length > 0 && (
              <span className="absolute top-1.5 right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#7895B2] text-white font-mono text-[10px] font-semibold flex items-center justify-center tabular-nums">
                {incomingRequests.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setTab('calls')}
            className={`w-12 h-12 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
              tab === 'calls'
                ? 'bg-[#FFFFFF] text-[#7895B2] border border-[#E6EBF0]'
                : 'text-[#5D6D7E] hover:text-[#283747] hover:bg-[#FFFFFF]/70'
            }`}
            title="Call History"
            aria-label="Call History"
          >
            <Phone className="w-5 h-5" strokeWidth={1.6} />
          </button>
        </div>

        <button
          type="button"
          onClick={() => setShowProfileModal(true)}
          className="rounded-full p-1 hover:bg-[#FFFFFF] transition-colors cursor-pointer"
          title={`Signed in as @${user.username}`}
          aria-label="Open profile settings"
        >
          <Avatar name={user.displayName} color={user.avatarColor} size="md" online showPresence />
        </button>
      </nav>

      {/* Conversations Sidebar */}
      <aside
        className={`${
          showMobileDetail ? 'hidden md:flex' : 'flex'
        } w-full md:w-80 lg:w-84 bg-[#FFFFFF] border-r border-[#E6EBF0] flex-col min-h-0 shrink-0`}
      >
        <div className="h-16 px-4 border-b border-[#E6EBF0] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <img
              src="/assets/aistudio/Dusty_Blue_Chat_Bubble_Icon__1__dfe423b3.png"
              alt="Chattr"
              className="md:hidden w-8 h-8 rounded-lg object-cover shrink-0"
            />
            <div className="min-w-0">
              <div className="font-display text-base font-semibold text-[#283747] truncate">
                Chattr
              </div>
              <div className="font-mono text-[11px] text-[#7895B2] truncate">@{user.username}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setTab('friends')}
            className="min-h-[38px] px-3 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
          >
            <UserPlus className="w-3.5 h-3.5 text-[#7895B2]" strokeWidth={1.6} />
            <span>Add Friend</span>
          </button>
        </div>

        <div className="p-3 border-b border-[#F4F6F8] shrink-0">
          <div className="relative">
            <Search
              className="w-4 h-4 text-[#7895B2] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              strokeWidth={1.6}
            />
            <input
              type="text"
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
              placeholder="Filter friends..."
              className="w-full h-9 pl-9 pr-3 bg-[#F4F6F8] border border-transparent focus:border-[#7895B2] focus:bg-[#FFFFFF] rounded-xl text-sm text-[#283747] placeholder:text-[#94A3B8] focus:outline-none transition-colors"
            />
          </div>
        </div>

        {incomingRequests.length > 0 && (
          <button
            type="button"
            onClick={() => setTab('friends')}
            className="mx-3 mt-3 px-3.5 py-2.5 rounded-xl bg-[#7895B2]/10 border border-[#7895B2]/25 text-left flex items-center justify-between gap-2 hover:bg-[#7895B2]/15 transition-colors cursor-pointer"
          >
            <span className="text-xs font-semibold text-[#283747]">
              {incomingRequests.length} pending friend{' '}
              {incomingRequests.length === 1 ? 'request' : 'requests'}
            </span>
            <span className="text-xs font-medium text-[#7895B2]">Review</span>
          </button>
        )}

        <div className="flex-1 overflow-y-auto chat-scroll p-2 space-y-0.5 pb-20 md:pb-2">
          {filteredFriends.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm font-medium text-[#283747]">
                {friends.length === 0 ? 'No conversations yet' : 'No matching friends'}
              </p>
              <p className="text-xs text-[#5D6D7E] mt-1">
                {friends.length === 0
                  ? 'Add a friend by their username to start texting or calling.'
                  : 'Try another username or name.'}
              </p>
              {friends.length === 0 && (
                <button
                  type="button"
                  onClick={() => setTab('friends')}
                  className="mt-4 h-9 px-4 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <UserPlus className="w-3.5 h-3.5" strokeWidth={1.6} />
                  <span>Find Friends</span>
                </button>
              )}
            </div>
          ) : (
            filteredFriends.map((friend) => {
              const isSelected = tab === 'messages' && selectedFriendId === friend.id;
              const isFriendTyping = Boolean(typingUsers[friend.id]);

              return (
                <button
                  key={friend.id}
                  type="button"
                  onClick={() => handleOpenChat(friend.id)}
                  className={`w-full px-3 py-2.5 rounded-xl flex items-center gap-3 text-left transition-colors cursor-pointer ${
                    isSelected ? 'bg-[#F4F6F8]' : 'hover:bg-[#F4F6F8]/60'
                  }`}
                >
                  <Avatar
                    name={friend.displayName}
                    color={friend.avatarColor}
                    size="md"
                    online={friend.online}
                    inCall={friend.inCall}
                    showPresence
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-sm truncate ${
                          isSelected || friend.unreadCount > 0
                            ? 'font-semibold text-[#283747]'
                            : 'font-medium text-[#283747]'
                        }`}
                      >
                        {friend.displayName}
                      </span>
                      {friend.lastMessage && (
                        <span className="font-mono text-[11px] text-[#94A3B8] shrink-0 tabular-nums">
                          {new Date(friend.lastMessage.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <span
                        className={`text-xs truncate ${
                          isFriendTyping
                            ? 'text-[#7895B2] font-medium'
                            : friend.unreadCount > 0
                            ? 'text-[#283747] font-medium'
                            : 'text-[#5D6D7E]'
                        }`}
                      >
                        {isFriendTyping
                          ? 'Typing...'
                          : friend.lastMessage
                          ? `${
                              friend.lastMessage.senderId === user.id &&
                              friend.lastMessage.kind === 'text'
                                ? 'You: '
                                : ''
                            }${friend.lastMessage.body}`
                          : `@${friend.username}`}
                      </span>

                      {friend.unreadCount > 0 && (
                        <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-[#7895B2] text-white font-mono text-[11px] font-semibold flex items-center justify-center shrink-0 tabular-nums">
                          {friend.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* Main Content Viewport */}
      <main
        className={`${
          showMobileDetail ? 'flex' : 'hidden md:flex'
        } flex-1 flex-col min-w-0 min-h-0 pb-16 md:pb-0 bg-[#FFFFFF]`}
      >
        {tab === 'friends' ? (
          <FriendsView
            friends={friends}
            incomingRequests={incomingRequests}
            outgoingRequests={outgoingRequests}
            onRefreshFriends={refreshFriends}
            onOpenChat={handleOpenChat}
            onStartCall={(friend, type) => void handleStartCall(friend, type)}
          />
        ) : tab === 'calls' ? (
          <CallsView
            calls={calls}
            onlineMap={onlineMap}
            onStartCall={(peer, type) => void handleStartCall(peer, type)}
            onOpenChat={handleOpenChat}
          />
        ) : selectedFriend ? (
          <ChatView
            currentUser={user}
            friend={selectedFriend}
            messages={messagesByFriend[selectedFriend.id] || []}
            loading={loadingMessagesFor === selectedFriend.id}
            isTyping={Boolean(typingUsers[selectedFriend.id])}
            onBackMobile={() => setSelectedFriendId(null)}
            onSendMessage={handleSendMessage}
            onReactMessage={handleReactMessage}
            onDeleteMessage={handleDeleteMessage}
            onTypingChange={(typing) =>
              sendWs(typing ? 'typing:start' : 'typing:stop', { toUserId: selectedFriend.id })
            }
            onStartCall={(friend, type) => void handleStartCall(friend, type)}
            onRemoveFriend={handleRemoveFriend}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center bg-[#FFFFFF] p-8 text-center">
            <div className="w-72 aspect-[4/3] rounded-2xl overflow-hidden border border-[#E6EBF0] bg-[#F4F6F8] mb-6">
              <img
                src="/src/assets/images/empty_chat_artwork_1794565019150.jpg"
                alt="Chattr clean messaging illustration"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
            <h1 className="font-display text-2xl font-semibold text-[#283747]">
              Select a friend to text or call
            </h1>
            <p className="text-sm text-[#5D6D7E] mt-2 max-w-md leading-relaxed">
              Choose a conversation on the left, or open the Friends directory to search usernames and add new connections.
            </p>
            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setTab('friends')}
                className="h-10 px-4 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white text-sm font-medium flex items-center gap-2 transition-colors cursor-pointer"
              >
                <UserPlus className="w-4 h-4" strokeWidth={1.6} />
                <span>Add Friends</span>
              </button>
              <button
                type="button"
                onClick={() => setTab('calls')}
                className="h-10 px-4 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747] text-sm font-medium flex items-center gap-2 transition-colors cursor-pointer"
              >
                <Video className="w-4 h-4 text-[#7895B2]" strokeWidth={1.6} />
                <span>Call History</span>
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Mobile Bottom Tab Bar */}
      <nav
        aria-label="Mobile navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 h-16 bg-[#FFFFFF]/95 backdrop-blur-md border-t border-[#E6EBF0] grid grid-cols-4 items-center"
      >
        <button
          type="button"
          onClick={() => setTab('messages')}
          className={`relative h-full flex flex-col items-center justify-center gap-1 cursor-pointer ${
            tab === 'messages' ? 'text-[#7895B2]' : 'text-[#5D6D7E]'
          }`}
        >
          <MessageSquare className="w-5 h-5" strokeWidth={1.6} />
          <span className="text-[10px] font-medium">Messages</span>
          {totalUnread > 0 && (
            <span className="absolute top-2 right-5 min-w-[16px] h-4 px-1 rounded-full bg-[#7895B2] text-white font-mono text-[10px] flex items-center justify-center tabular-nums">
              {totalUnread}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setTab('friends')}
          className={`relative h-full flex flex-col items-center justify-center gap-1 cursor-pointer ${
            tab === 'friends' ? 'text-[#7895B2]' : 'text-[#5D6D7E]'
          }`}
        >
          <Users className="w-5 h-5" strokeWidth={1.6} />
          <span className="text-[10px] font-medium">Friends</span>
          {incomingRequests.length > 0 && (
            <span className="absolute top-2 right-5 min-w-[16px] h-4 px-1 rounded-full bg-[#7895B2] text-white font-mono text-[10px] font-semibold flex items-center justify-center tabular-nums">
              {incomingRequests.length}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setTab('calls')}
          className={`h-full flex flex-col items-center justify-center gap-1 cursor-pointer ${
            tab === 'calls' ? 'text-[#7895B2]' : 'text-[#5D6D7E]'
          }`}
        >
          <Phone className="w-5 h-5" strokeWidth={1.6} />
          <span className="text-[10px] font-medium">Calls</span>
        </button>

        <button
          type="button"
          onClick={() => setShowProfileModal(true)}
          className="h-full flex flex-col items-center justify-center gap-1 text-[#5D6D7E] cursor-pointer"
        >
          <Avatar name={user.displayName} color={user.avatarColor} size="xs" />
          <span className="text-[10px] font-medium">Profile</span>
        </button>
      </nav>

      {/* Modals & Call Overlays */}
      {showProfileModal && (
        <ProfileModal
          user={user}
          onClose={() => setShowProfileModal(false)}
          onUpdated={(updated) => setUser(updated)}
          onLogout={handleLogout}
        />
      )}

      <CallStage
        incomingCall={incomingCall}
        activeCall={activeCall}
        localStream={localStream}
        remoteStream={remoteStream}
        onAcceptIncoming={() => void handleAcceptIncoming()}
        onDeclineIncoming={handleDeclineIncoming}
        onEndCall={handleEndCall}
        onToggleAudio={handleToggleAudio}
        onToggleVideo={handleToggleVideo}
      />

      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-[#FFFFFF] text-[#283747] text-sm font-medium px-4 py-2.5 rounded-xl shadow-[0_4px_16px_rgba(40,55,71,0.08)] border border-[#E6EBF0]">
          {toast}
        </div>
      )}
    </div>
  );
}
