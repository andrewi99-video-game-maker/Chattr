import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageSquare,
  Phone,
  Search,
  UserPlus,
  Users,
  Video,
} from 'lucide-react';
import { signOut } from 'firebase/auth';
import { AuthScreen } from './components/AuthScreen.tsx';
import { Avatar } from './components/Avatar.tsx';
import { CallStage } from './components/CallStage.tsx';
import { CallsView } from './components/CallsView.tsx';
import { ChatView } from './components/ChatView.tsx';
import { FriendsView } from './components/FriendsView.tsx';
import { ProfileModal } from './components/ProfileModal.tsx';
import { SafeImage } from './components/SafeImage.tsx';
import {
  ApiError,
  apiRequest,
  getStoredSelectedFriend,
  getStoredToken,
  setLastUsername,
  setStoredSelectedFriend,
  setStoredToken,
} from './lib/api.ts';
import { CHATTR_ASSETS } from './lib/assets.ts';
import { auth } from './lib/firebase.ts';
import {
  createCallRecordFirestore,
  deleteMessageFirestore,
  editMessageFirestore,
  getUserProfileFirestore,
  lookupUserByUsernameFirestore,
  markMessagesReadFirestore,
  removeFriendFirestore,
  respondToFriendRequestFirestore,
  sendFriendRequestFirestore,
  sendMessageFirestore,
  subscribeToCallsFirestore,
  subscribeToFriendshipsFirestore,
  subscribeToMessagesFirestore,
  toggleReactionFirestore,
  updateCallRecordFirestore,
} from './lib/firestoreChattr.ts';
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
  const [bootError, setBootError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [authMode, setAuthMode] = useState<'local' | 'firebase'>('local');

  const [tab, setTab] = useState<WorkspaceTab>('messages');
  const [localFriends, setLocalFriends] = useState<FriendItem[]>([]);
  const [localIncoming, setLocalIncoming] = useState<FriendRequestItem[]>([]);
  const [localOutgoing, setLocalOutgoing] = useState<FriendRequestItem[]>([]);
  const [localCalls, setLocalCalls] = useState<CallLogItem[]>([]);

  const [fsFriends, setFsFriends] = useState<FriendItem[]>([]);
  const [fsIncoming, setFsIncoming] = useState<FriendRequestItem[]>([]);
  const [fsOutgoing, setFsOutgoing] = useState<FriendRequestItem[]>([]);
  const [fsCalls, setFsCalls] = useState<CallLogItem[]>([]);
  const [presenceByUid, setPresenceByUid] = useState<Record<string, { online: boolean; inCall: boolean }>>({});

  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(() =>
    getStoredSelectedFriend()
  );
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
  const authModeRef = useRef<'local' | 'firebase'>('local');
  const firestorePeerIdsRef = useRef<Set<string>>(new Set());
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

  useEffect(() => {
    authModeRef.current = authMode;
  }, [authMode]);

  useEffect(() => {
    const set = new Set<string>();
    for (const f of fsFriends) set.add(f.id);
    for (const r of fsIncoming) set.add(r.user.id);
    for (const r of fsOutgoing) set.add(r.user.id);
    firestorePeerIdsRef.current = set;
  }, [fsFriends, fsIncoming, fsOutgoing]);

  const friends = useMemo(() => {
    const map = new Map<string, FriendItem>();
    for (const f of localFriends) {
      const pres = presenceByUid[f.id];
      map.set(f.id, {
        ...f,
        online: pres ? pres.online : f.online,
        inCall: pres ? pres.inCall : f.inCall,
      });
    }
    for (const f of fsFriends) {
      const existing = map.get(f.id);
      const pres = presenceByUid[f.id];
      const fsMsgs = messagesByFriend[f.id];
      const lastFsMsg = fsMsgs && fsMsgs.length > 0 ? fsMsgs[fsMsgs.length - 1] : null;
      const unreadFs =
        fsMsgs && user
          ? fsMsgs.filter((m) => m.senderId === f.id && !m.readAt).length
          : 0;
      map.set(f.id, {
        ...f,
        online: pres ? pres.online : existing?.online ?? false,
        inCall: pres ? pres.inCall : existing?.inCall ?? false,
        lastMessage: lastFsMsg || existing?.lastMessage || null,
        unreadCount: fsMsgs ? unreadFs : existing?.unreadCount ?? 0,
      });
    }
    const list = Array.from(map.values());
    list.sort((a, b) => {
      const aTime = a.lastMessage?.createdAt ?? a.createdAt;
      const bTime = b.lastMessage?.createdAt ?? b.createdAt;
      return bTime - aTime;
    });
    return list;
  }, [localFriends, fsFriends, presenceByUid, messagesByFriend, user]);

  const incomingRequests = useMemo(() => {
    const map = new Map<string, FriendRequestItem>();
    for (const r of localIncoming) map.set(r.user.id, r);
    for (const r of fsIncoming) map.set(r.user.id, r);
    return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
  }, [localIncoming, fsIncoming]);

  const outgoingRequests = useMemo(() => {
    const map = new Map<string, FriendRequestItem>();
    for (const r of localOutgoing) map.set(r.user.id, r);
    for (const r of fsOutgoing) map.set(r.user.id, r);
    return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
  }, [localOutgoing, fsOutgoing]);

  const calls = useMemo(() => {
    const map = new Map<string, CallLogItem>();
    for (const c of localCalls) map.set(c.id, c);
    for (const c of fsCalls) map.set(c.id, c);
    return Array.from(map.values()).sort((a, b) => b.startedAt - a.startedAt);
  }, [localCalls, fsCalls]);

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
      setLocalFriends(data.friends);
      setLocalIncoming(data.incomingRequests);
      setLocalOutgoing(data.outgoingRequests);
      setPresenceByUid((prev) => {
        const next = { ...prev };
        for (const f of data.friends) {
          next[f.id] = { online: f.online, inCall: f.inCall };
        }
        return next;
      });
    } catch {
      // ignore transient error
    }
  }, []);

  const refreshCalls = useCallback(async () => {
    try {
      const data = await apiRequest<{ calls: CallLogItem[] }>('/api/calls');
      setLocalCalls(data.calls);
    } catch {
      // ignore transient error
    }
  }, []);

  const loadMessages = useCallback(async (friendId: string) => {
    if (authModeRef.current === 'firebase' && firestorePeerIdsRef.current.has(friendId)) {
      return;
    }
    setLoadingMessagesFor(friendId);
    try {
      const data = await apiRequest<{ messages: ChatMessage[] }>(`/api/messages/${friendId}`);
      setMessagesByFriend((prev) => ({
        ...prev,
        [friendId]: data.messages,
      }));
      setLocalFriends((prev) =>
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

  // Boot session check (supports both local sessions and Firebase Google Auth persistence)
  const checkSession = useCallback(async () => {
    setBooting(true);
    setBootError(null);
    try {
      await auth.authStateReady();
      const stored = getStoredToken();

      if (stored) {
        try {
          const data = await apiRequest<{ user: PublicUser }>('/api/auth/me');
          const isFb = Boolean(auth.currentUser && auth.currentUser.uid === data.user.id);
          setAuthMode(isFb ? 'firebase' : 'local');
          setUser({ ...data.user, authProvider: isFb ? 'google' : 'local' });
          setToken(stored);
          setLastUsername(data.user.username);
          setSessionNotice(null);
          return;
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            setStoredToken(null);
            setToken(null);
            if (!auth.currentUser) {
              setUser(null);
              setSessionNotice(
                'Your session expired or the server reset. Sign in or create an account to continue.'
              );
              return;
            }
          } else {
            setBootError('Unable to reach Chattr right now. Your session is still saved.');
            return;
          }
        }
      }

      // Restore Firebase Google session seamlessly if user already chose a handle
      if (auth.currentUser) {
        const fsProfile = await getUserProfileFirestore(auth.currentUser.uid).catch(() => null);
        if (fsProfile) {
          const idToken = await auth.currentUser.getIdToken();
          const bridgeRes = await apiRequest<{
            needsUsernameSetup: boolean;
            token?: string;
            user?: PublicUser;
          }>('/api/auth/firebase', {
            method: 'POST',
            body: JSON.stringify({
              idToken,
              username: fsProfile.username,
              displayName: fsProfile.displayName,
              bio: fsProfile.bio,
              avatarColor: fsProfile.avatarColor,
            }),
          });
          if (bridgeRes.token && bridgeRes.user) {
            setStoredToken(bridgeRes.token);
            setToken(bridgeRes.token);
            setAuthMode('firebase');
            setUser({ ...bridgeRes.user, authProvider: 'google' });
            setLastUsername(bridgeRes.user.username);
            setSessionNotice(null);
            return;
          }
        }
      }
    } catch {
      // fall back to auth screen
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    setStoredSelectedFriend(selectedFriendId);
  }, [selectedFriendId]);

  // Real-time Firestore subscriptions for Google/Firebase authenticated users
  useEffect(() => {
    if (!user || authMode !== 'firebase') {
      setFsFriends([]);
      setFsIncoming([]);
      setFsOutgoing([]);
      setFsCalls([]);
      return;
    }

    const unsubFriends = subscribeToFriendshipsFirestore(user.id, (data) => {
      setFsFriends(data.friends);
      setFsIncoming(data.incomingRequests);
      setFsOutgoing(data.outgoingRequests);
    });

    const unsubCalls = subscribeToCallsFirestore(user.id, (callList) => {
      setFsCalls(callList);
    });

    return () => {
      unsubFriends();
      unsubCalls();
    };
  }, [user?.id, authMode]);

  // Real-time Firestore message listeners for Google-to-Google conversations
  useEffect(() => {
    if (!user || authMode !== 'firebase' || fsFriends.length === 0) return;

    const unsubs = fsFriends.map((friend) =>
      subscribeToMessagesFirestore(user.id, friend.id, (msgs) => {
        setMessagesByFriend((prev) => {
          const prevList = prev[friend.id] || [];
          const newest = msgs[msgs.length - 1];
          const prevNewest = prevList[prevList.length - 1];
          if (
            newest &&
            newest.id !== prevNewest?.id &&
            newest.senderId !== user.id &&
            newest.kind === 'text' &&
            Date.now() - newest.createdAt < 10_000
          ) {
            playMessageCue();
          }
          return { ...prev, [friend.id]: msgs };
        });

        const isViewing =
          tabRef.current === 'messages' && selectedFriendIdRef.current === friend.id;
        if (isViewing) {
          const unreadIds = msgs
            .filter((m) => m.senderId === friend.id && !m.readAt)
            .map((m) => m.id);
          if (unreadIds.length > 0) {
            void markMessagesReadFirestore(user.id, friend.id, unreadIds).catch(() => {});
          }
        }
      })
    );

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [user?.id, authMode, fsFriends]);

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
          setPresenceByUid((prev) => ({ ...prev, [uid]: { online, inCall } }));
          setLocalFriends((prev) =>
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

          setLocalFriends((prev) => {
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
          const cur = activeCallRef.current;
          if (cur && authModeRef.current === 'firebase' && firestorePeerIdsRef.current.has(cur.peer.id)) {
            void updateCallRecordFirestore({
              callId: cur.callId,
              status: 'missed',
              durationSec: 0,
            }).catch(() => {});
          }
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
    if (authMode === 'firebase' && firestorePeerIdsRef.current.has(selectedFriendId)) {
      const msgs = messagesByFriend[selectedFriendId] || [];
      const unreadIds = msgs
        .filter((m) => m.senderId === selectedFriendId && !m.readAt)
        .map((m) => m.id);
      if (unreadIds.length > 0) {
        void markMessagesReadFirestore(user.id, selectedFriendId, unreadIds).catch(() => {});
      }
      return;
    }
    void loadMessages(selectedFriendId);
  }, [selectedFriendId, user?.id, authMode, loadMessages]);

  const handleAuthenticated = useCallback(
    (authedUser: PublicUser, authedToken: string, mode: 'local' | 'firebase') => {
      setSessionNotice(null);
      setAuthMode(mode);
      setUser(authedUser);
      setToken(authedToken);
      setLastUsername(authedUser.username);
    },
    []
  );

  const handleLogout = useCallback(async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    if (auth.currentUser) {
      await signOut(auth).catch(() => {});
    }
    cleanupCallMedia();
    setStoredToken(null);
    setStoredSelectedFriend(null);
    setAuthMode('local');
    setUser(null);
    setToken(null);
    setLocalFriends([]);
    setLocalIncoming([]);
    setLocalOutgoing([]);
    setLocalCalls([]);
    setFsFriends([]);
    setFsIncoming([]);
    setFsOutgoing([]);
    setFsCalls([]);
    setPresenceByUid({});
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
      if (authModeRef.current === 'firebase' && firestorePeerIdsRef.current.has(peer.id) && userRef.current) {
        void createCallRecordFirestore({
          id: callId,
          callerId: userRef.current.id,
          calleeId: peer.id,
          callType,
        }).catch(() => {});
      }
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
    if (authModeRef.current === 'firebase' && firestorePeerIdsRef.current.has(inc.caller.id)) {
      void updateCallRecordFirestore({ callId: inc.callId, status: 'active' }).catch(() => {});
    }
    sendWs('call:accept', { callId: inc.callId, toUserId: inc.caller.id });
  }, [acquireMedia, createPeerConnection, sendWs]);

  const handleDeclineIncoming = useCallback(() => {
    const inc = incomingCallRef.current;
    if (!inc) return;
    stopCallTones();
    setIncomingCall(null);
    if (authModeRef.current === 'firebase' && firestorePeerIdsRef.current.has(inc.caller.id)) {
      void updateCallRecordFirestore({ callId: inc.callId, status: 'declined', durationSec: 0 }).catch(
        () => {}
      );
    }
    sendWs('call:decline', { callId: inc.callId, toUserId: inc.caller.id });
  }, [sendWs]);

  const handleEndCall = useCallback(() => {
    const cur = activeCallRef.current;
    if (!cur) return;
    if (authModeRef.current === 'firebase' && firestorePeerIdsRef.current.has(cur.peer.id)) {
      const isConnected = cur.connectedAt !== null;
      const durationSec = isConnected
        ? Math.max(1, Math.round((Date.now() - cur.connectedAt!) / 1000))
        : 0;
      void updateCallRecordFirestore({
        callId: cur.callId,
        status: isConnected ? 'ended' : 'missed',
        durationSec,
      }).catch(() => {});
    }
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
      if (!selectedFriendId || !userRef.current) return;
      if (authModeRef.current === 'firebase' && firestorePeerIdsRef.current.has(selectedFriendId)) {
        const list = messagesByFriend[selectedFriendId] || [];
        const replyTarget = replyToId ? list.find((m) => m.id === replyToId) || null : null;
        await sendMessageFirestore({
          senderId: userRef.current.id,
          recipientId: selectedFriendId,
          body,
          replyTo: replyTarget
            ? { id: replyTarget.id, senderId: replyTarget.senderId, body: replyTarget.body }
            : null,
          kind: 'text',
        });
        return;
      }

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
    [selectedFriendId, messagesByFriend]
  );

  const handleEditMessage = useCallback(
    async (messageId: string, body: string) => {
      if (
        selectedFriendId &&
        userRef.current &&
        authModeRef.current === 'firebase' &&
        firestorePeerIdsRef.current.has(selectedFriendId)
      ) {
        await editMessageFirestore(userRef.current.id, selectedFriendId, messageId, body);
        return;
      }

      const data = await apiRequest<{ message: ChatMessage }>(`/api/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      });
      const peerId =
        data.message.senderId === userRef.current?.id
          ? data.message.recipientId
          : data.message.senderId;
      setMessagesByFriend((prev) => {
        const list = prev[peerId];
        if (!list) return prev;
        return {
          ...prev,
          [peerId]: list.map((m) => (m.id === data.message.id ? data.message : m)),
        };
      });
    },
    [selectedFriendId]
  );

  const handleReactMessage = useCallback(
    async (messageId: string, emoji: string) => {
      if (
        selectedFriendId &&
        userRef.current &&
        authModeRef.current === 'firebase' &&
        firestorePeerIdsRef.current.has(selectedFriendId)
      ) {
        const currentMsg = (messagesByFriend[selectedFriendId] || []).find((m) => m.id === messageId);
        await toggleReactionFirestore(
          userRef.current.id,
          selectedFriendId,
          messageId,
          emoji,
          currentMsg?.reactions || {}
        );
        return;
      }

      await apiRequest(`/api/messages/${messageId}/react`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      });
    },
    [selectedFriendId, messagesByFriend]
  );

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (
        selectedFriendId &&
        userRef.current &&
        authModeRef.current === 'firebase' &&
        firestorePeerIdsRef.current.has(selectedFriendId)
      ) {
        await deleteMessageFirestore(userRef.current.id, selectedFriendId, messageId);
        return;
      }

      await apiRequest(`/api/messages/${messageId}`, { method: 'DELETE' });
    },
    [selectedFriendId]
  );

  // Auto-cancel outgoing ringing call after 45 seconds if unanswered
  useEffect(() => {
    if (!activeCall || activeCall.direction !== 'outgoing' || activeCall.phase !== 'ringing') {
      return;
    }
    const timer = window.setTimeout(() => {
      if (
        activeCallRef.current &&
        activeCallRef.current.callId === activeCall.callId &&
        activeCallRef.current.phase === 'ringing'
      ) {
        handleEndCall();
        showToast('No answer.');
      }
    }, 45_000);
    return () => window.clearTimeout(timer);
  }, [activeCall?.callId, activeCall?.direction, activeCall?.phase, handleEndCall, showToast]);

  const handleSendFriendRequest = useCallback(
    async (target: {
      username?: string;
      targetUserId?: string;
    }): Promise<{ status: string; username?: string }> => {
      if (authModeRef.current === 'firebase' && userRef.current) {
        let fsTarget: PublicUser | null = null;
        if (target.targetUserId) {
          fsTarget = await getUserProfileFirestore(target.targetUserId).catch(() => null);
        } else if (target.username) {
          fsTarget = await lookupUserByUsernameFirestore(target.username).catch(() => null);
        }

        if (fsTarget) {
          if (fsTarget.id === userRef.current.id) {
            throw new Error('You cannot add yourself as a friend.');
          }
          const fsRes = await sendFriendRequestFirestore(userRef.current.id, fsTarget.id);
          // Also notify peer over Express/WS if present on server
          await apiRequest('/api/friends/request', {
            method: 'POST',
            body: JSON.stringify({ targetUserId: fsTarget.id }),
          }).catch(() => {});
          return { status: fsRes.status, username: fsTarget.username };
        }
      }

      const res = await apiRequest<{ status: string }>('/api/friends/request', {
        method: 'POST',
        body: JSON.stringify(target),
      });
      await refreshFriends();
      return { status: res.status, username: target.username };
    },
    [refreshFriends]
  );

  const handleRespondFriendRequest = useCallback(
    async (friendshipId: string, action: 'accept' | 'decline' | 'cancel', peerId: string) => {
      if (
        authModeRef.current === 'firebase' &&
        userRef.current &&
        firestorePeerIdsRef.current.has(peerId)
      ) {
        await respondToFriendRequestFirestore(friendshipId, action, userRef.current.id, peerId);
        // Mirror cleanup/sync with server if an equivalent local friendship exists
        await apiRequest('/api/friends/respond', {
          method: 'POST',
          body: JSON.stringify({ friendshipId, action }),
        }).catch(() => {});
        return;
      }

      await apiRequest('/api/friends/respond', {
        method: 'POST',
        body: JSON.stringify({ friendshipId, action }),
      });
      await refreshFriends();
    },
    [refreshFriends]
  );

  const handleRemoveFriend = useCallback(
    async (friendId: string) => {
      const friendObj = fsFriends.find((f) => f.id === friendId);
      if (authModeRef.current === 'firebase' && friendObj) {
        await removeFriendFirestore(friendObj.friendshipId);
      }
      await apiRequest(`/api/friends/${friendId}`, { method: 'DELETE' }).catch(() => {});
      if (selectedFriendId === friendId) {
        setSelectedFriendId(null);
      }
      await refreshFriends();
      showToast('Friend removed.');
    },
    [fsFriends, refreshFriends, selectedFriendId, showToast]
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

  useEffect(() => {
    document.title =
      totalUnread > 0 ? `(${totalUnread}) Chattr — Texting & Calling` : 'Chattr — Texting & Calling';
  }, [totalUnread]);

  if (booting) {
    return (
      <div className="min-h-screen bg-[#FFFFFF] flex items-center justify-center text-sm text-[#5D6D7E]">
        Loading Chattr...
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="min-h-screen bg-[#FFFFFF] flex flex-col items-center justify-center p-6 text-center">
        <div className="w-12 h-12 rounded-2xl overflow-hidden mb-4">
          <SafeImage src={CHATTR_ASSETS.logo} alt="Chattr" className="w-full h-full object-cover" />
        </div>
        <h1 className="font-display text-lg font-semibold text-[#283747]">Connection Issue</h1>
        <p className="text-sm text-[#5D6D7E] mt-1 max-w-sm">{bootError}</p>
        <button
          type="button"
          onClick={() => void checkSession()}
          className="mt-5 h-10 px-5 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white text-sm font-medium transition-colors cursor-pointer"
        >
          Retry Connection
        </button>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen sessionNotice={sessionNotice} onAuthenticated={handleAuthenticated} />;
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
          <div className="w-10 h-10 rounded-xl overflow-hidden mb-3 select-none shrink-0">
            <SafeImage
              src={CHATTR_ASSETS.logo}
              alt="Chattr"
              className="w-full h-full object-cover"
            />
          </div>

          <button
            type="button"
            onClick={() => setTab('messages')}
            className={`relative w-12 h-12 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
              tab === 'messages'
                ? 'bg-[#FFFFFF] text-[#7895B2] border border-[#E6EBF0] shadow-[0_1px_3px_rgba(40,55,71,0.06)]'
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
                ? 'bg-[#FFFFFF] text-[#7895B2] border border-[#E6EBF0] shadow-[0_1px_3px_rgba(40,55,71,0.06)]'
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
                ? 'bg-[#FFFFFF] text-[#7895B2] border border-[#E6EBF0] shadow-[0_1px_3px_rgba(40,55,71,0.06)]'
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
            <div className="md:hidden w-8 h-8 rounded-lg overflow-hidden shrink-0">
              <SafeImage
                src={CHATTR_ASSETS.logo}
                alt="Chattr"
                className="w-full h-full object-cover"
              />
            </div>
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
                    isSelected ? 'bg-[#7895B2]/12' : 'hover:bg-[#F4F6F8]/80'
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
            currentUser={user}
            authMode={authMode}
            friends={friends}
            incomingRequests={incomingRequests}
            outgoingRequests={outgoingRequests}
            onSendFriendRequest={handleSendFriendRequest}
            onRespondFriendRequest={handleRespondFriendRequest}
            onRemoveFriend={handleRemoveFriend}
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
            onEditMessage={handleEditMessage}
            onReactMessage={handleReactMessage}
            onDeleteMessage={handleDeleteMessage}
            onTypingChange={(typing) =>
              sendWs(typing ? 'typing:start' : 'typing:stop', { toUserId: selectedFriend.id })
            }
            onStartCall={(friend, type) => void handleStartCall(friend, type)}
            onRemoveFriend={handleRemoveFriend}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center chat-canvas-bg p-8 text-center">
            <div className="w-72 sm:w-80 aspect-[4/3] rounded-2xl overflow-hidden border border-[#E6EBF0] bg-[#FFFFFF] shadow-[0_8px_24px_rgba(40,55,71,0.06)] mb-6">
              <SafeImage
                src={CHATTR_ASSETS.emptyChatArtwork}
                alt="Chattr clean messaging illustration"
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
          authMode={authMode}
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
