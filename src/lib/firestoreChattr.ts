import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import type {
  CallLogItem,
  CallStatus,
  CallType,
  ChatMessage,
  FriendItem,
  FriendRequestItem,
  PublicUser,
} from '../types.ts';
import { db, handleFirestoreError, OperationType } from './firebase.ts';

export const USERNAME_REGEX = /^[a-z0-9_.-]{3,24}$/;

export function normalizeUsername(input: string): string {
  return input.trim().replace(/^@+/, '').toLowerCase();
}

export function getPairId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join('_');
}

function toMillis(val: unknown, fallback = Date.now()): number {
  if (val instanceof Timestamp) return val.toMillis();
  if (typeof val === 'number') return val;
  if (val && typeof val === 'object' && 'toMillis' in val && typeof (val as { toMillis?: unknown }).toMillis === 'function') {
    return (val as { toMillis: () => number }).toMillis();
  }
  return fallback;
}

function mapUserDoc(data: Record<string, unknown>, fallbackId: string): PublicUser {
  return {
    id: typeof data.uid === 'string' ? data.uid : fallbackId,
    username: typeof data.username === 'string' ? data.username : '',
    displayName: typeof data.displayName === 'string' ? data.displayName : 'Chattr User',
    bio: typeof data.bio === 'string' ? data.bio : '',
    avatarColor: typeof data.avatarColor === 'string' ? data.avatarColor : '#7895B2',
    createdAt: toMillis(data.createdAt),
    authProvider: 'google',
  };
}

export async function getUserProfileFirestore(uid: string): Promise<PublicUser | null> {
  const path = `users/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) return null;
    return mapUserDoc(snap.data(), uid);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function isUsernameAvailableFirestore(
  usernameInput: string,
  excludeUid?: string
): Promise<{ valid: boolean; available: boolean; reason?: string }> {
  const clean = normalizeUsername(usernameInput);
  if (!USERNAME_REGEX.test(clean)) {
    return {
      valid: false,
      available: false,
      reason:
        clean.length < 3
          ? 'At least 3 characters required.'
          : 'Use only letters, numbers, _, ., or -.',
    };
  }
  const path = `usernames/${clean}`;
  try {
    const snap = await getDoc(doc(db, 'usernames', clean));
    if (!snap.exists()) {
      return { valid: true, available: true };
    }
    const ownerUid = snap.data().uid;
    if (excludeUid && ownerUid === excludeUid) {
      return { valid: true, available: true };
    }
    return { valid: true, available: false, reason: 'That username is already taken.' };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function lookupUserByUsernameFirestore(usernameInput: string): Promise<PublicUser | null> {
  const clean = normalizeUsername(usernameInput);
  if (!USERNAME_REGEX.test(clean)) return null;
  const path = `usernames/${clean}`;
  try {
    const snap = await getDoc(doc(db, 'usernames', clean));
    if (!snap.exists()) return null;
    const ownerUid = snap.data().uid;
    if (typeof ownerUid !== 'string' || !ownerUid) return null;
    return await getUserProfileFirestore(ownerUid);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function claimUsernameAndSaveProfileFirestore(params: {
  uid: string;
  email: string;
  username: string;
  displayName: string;
  bio?: string;
  avatarColor?: string;
}): Promise<PublicUser> {
  const clean = normalizeUsername(params.username);
  if (!USERNAME_REGEX.test(clean)) {
    throw new Error('Username must be 3–24 characters using letters, numbers, underscores, dots, or hyphens.');
  }

  const userRef = doc(db, 'users', params.uid);
  const privateRef = doc(db, 'users', params.uid, 'private', 'info');
  const newUsernameRef = doc(db, 'usernames', clean);

  try {
    const [existingUserSnap, existingUsernameSnap, existingPrivateSnap] = await Promise.all([
      getDoc(userRef),
      getDoc(newUsernameRef),
      getDoc(privateRef),
    ]);

    if (existingUsernameSnap.exists() && existingUsernameSnap.data().uid !== params.uid) {
      throw new Error('That username is already taken.');
    }

    const existingData = existingUserSnap.exists() ? existingUserSnap.data() : null;
    const previousUsername =
      existingData && typeof existingData.username === 'string' ? existingData.username : null;

    const finalDisplayName =
      params.displayName.trim().slice(0, 40) ||
      (existingData && typeof existingData.displayName === 'string' ? existingData.displayName : '') ||
      clean;
    const finalBio =
      typeof params.bio === 'string'
        ? params.bio.trim().slice(0, 140)
        : existingData && typeof existingData.bio === 'string'
        ? existingData.bio
        : '';
    const finalColor =
      params.avatarColor && /^#[0-9A-Fa-f]{6}$/.test(params.avatarColor)
        ? params.avatarColor
        : existingData && typeof existingData.avatarColor === 'string'
        ? existingData.avatarColor
        : '#7895B2';

    const batch = writeBatch(db);

    if (previousUsername && previousUsername !== clean) {
      batch.delete(doc(db, 'usernames', previousUsername));
    }

    if (!existingUsernameSnap.exists() || previousUsername !== clean) {
      batch.set(newUsernameRef, {
        uid: params.uid,
        username: clean,
        createdAt: serverTimestamp(),
      });
    }

    if (!existingUserSnap.exists()) {
      batch.set(userRef, {
        uid: params.uid,
        username: clean,
        displayName: finalDisplayName,
        bio: finalBio,
        avatarColor: finalColor,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.update(userRef, {
        username: clean,
        displayName: finalDisplayName,
        bio: finalBio,
        avatarColor: finalColor,
        updatedAt: serverTimestamp(),
      });
    }

    if (!existingPrivateSnap.exists()) {
      batch.set(privateRef, {
        uid: params.uid,
        email: (params.email || '').slice(0, 254),
        updatedAt: serverTimestamp(),
      });
    } else if (params.email && existingPrivateSnap.data().email !== params.email) {
      batch.update(privateRef, {
        email: params.email.slice(0, 254),
        updatedAt: serverTimestamp(),
      });
    }

    await batch.commit();

    return {
      id: params.uid,
      username: clean,
      displayName: finalDisplayName,
      bio: finalBio,
      avatarColor: finalColor,
      createdAt: existingData ? toMillis(existingData.createdAt) : Date.now(),
      authProvider: 'google',
    };
  } catch (err) {
    if (err instanceof Error && (err.message.includes('already taken') || err.message.includes('3–24'))) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `users/${params.uid}`);
  }
}

export function subscribeToFriendshipsFirestore(
  uid: string,
  onData: (data: {
    friends: FriendItem[];
    incomingRequests: FriendRequestItem[];
    outgoingRequests: FriendRequestItem[];
  }) => void
): Unsubscribe {
  const friendshipsQuery = query(
    collection(db, 'friendships'),
    where('participants', 'array-contains', uid)
  );

  return onSnapshot(
    friendshipsQuery,
    async (snap) => {
      try {
        const friends: FriendItem[] = [];
        const incomingRequests: FriendRequestItem[] = [];
        const outgoingRequests: FriendRequestItem[] = [];

        const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
        const peerIds = Array.from(
          new Set(
            docs
              .map(({ data }) =>
                data.requesterId === uid ? String(data.addresseeId) : String(data.requesterId)
              )
              .filter(Boolean)
          )
        );

        const peerMap = new Map<string, PublicUser>();
        await Promise.all(
          peerIds.map(async (peerId) => {
            try {
              const p = await getUserProfileFirestore(peerId);
              if (p) peerMap.set(peerId, p);
            } catch {
              // ignore individual unreadable peer
            }
          })
        );

        for (const { id, data } of docs) {
          const peerId = data.requesterId === uid ? String(data.addresseeId) : String(data.requesterId);
          const peer = peerMap.get(peerId);
          if (!peer) continue;
          const createdAt = toMillis(data.createdAt);

          if (data.status === 'accepted') {
            friends.push({
              ...peer,
              friendshipId: id,
              online: false,
              inCall: false,
              unreadCount: 0,
              lastMessage: null,
            });
          } else if (data.status === 'pending') {
            if (data.addresseeId === uid) {
              incomingRequests.push({ friendshipId: id, user: peer, createdAt });
            } else {
              outgoingRequests.push({ friendshipId: id, user: peer, createdAt });
            }
          }
        }

        incomingRequests.sort((a, b) => b.createdAt - a.createdAt);
        outgoingRequests.sort((a, b) => b.createdAt - a.createdAt);

        onData({ friends, incomingRequests, outgoingRequests });
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, 'friendships');
      }
    },
    (err) => {
      handleFirestoreError(err, OperationType.LIST, 'friendships');
    }
  );
}

export async function ensureConversationFirestore(uidA: string, uidB: string): Promise<string> {
  const pairId = getPairId(uidA, uidB);
  const convRef = doc(db, 'conversations', pairId);
  try {
    const snap = await getDoc(convRef);
    if (!snap.exists()) {
      await setDoc(convRef, {
        id: pairId,
        participants: [uidA, uidB].sort(),
        updatedAt: serverTimestamp(),
      });
    }
    return pairId;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `conversations/${pairId}`);
  }
}

export async function sendFriendRequestFirestore(
  meUid: string,
  targetUid: string
): Promise<{ status: 'pending' | 'accepted'; friendshipId: string }> {
  const pairId = getPairId(meUid, targetUid);
  const ref = doc(db, 'friendships', pairId);
  try {
    const existing = await getDoc(ref);
    if (existing.exists()) {
      const data = existing.data();
      if (data.status === 'accepted') {
        throw new Error('You are already friends.');
      }
      if (data.requesterId === targetUid) {
        await updateDoc(ref, {
          status: 'accepted',
          updatedAt: serverTimestamp(),
        });
        await ensureConversationFirestore(meUid, targetUid);
        return { status: 'accepted', friendshipId: pairId };
      }
      throw new Error('Friend request already sent.');
    }

    await setDoc(ref, {
      id: pairId,
      requesterId: meUid,
      addresseeId: targetUid,
      participants: [meUid, targetUid].sort(),
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { status: 'pending', friendshipId: pairId };
  } catch (err) {
    if (err instanceof Error && (err.message.includes('already friends') || err.message.includes('already sent'))) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `friendships/${pairId}`);
  }
}

export async function respondToFriendRequestFirestore(
  friendshipId: string,
  action: 'accept' | 'decline' | 'cancel',
  meUid: string,
  peerUid: string
): Promise<void> {
  const ref = doc(db, 'friendships', friendshipId);
  try {
    if (action === 'accept') {
      await updateDoc(ref, {
        status: 'accepted',
        updatedAt: serverTimestamp(),
      });
      await ensureConversationFirestore(meUid, peerUid);
    } else {
      await deleteDoc(ref);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `friendships/${friendshipId}`);
  }
}

export async function removeFriendFirestore(friendshipId: string): Promise<void> {
  const ref = doc(db, 'friendships', friendshipId);
  try {
    await deleteDoc(ref);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `friendships/${friendshipId}`);
  }
}

function mapMessageDoc(data: Record<string, unknown>, id: string): ChatMessage {
  const replyToId = typeof data.replyToId === 'string' && data.replyToId ? data.replyToId : null;
  const replyTo =
    replyToId && typeof data.replyToBody === 'string' && typeof data.replyToSenderId === 'string'
      ? {
          id: replyToId,
          senderId: data.replyToSenderId,
          body: data.replyToBody,
        }
      : null;

  const rawReactions =
    data.reactions && typeof data.reactions === 'object'
      ? (data.reactions as Record<string, string[]>)
      : {};

  return {
    id,
    senderId: String(data.senderId || ''),
    recipientId: String(data.recipientId || ''),
    body: String(data.body || ''),
    replyToId,
    replyTo,
    reactions: rawReactions,
    kind: data.kind === 'call_event' ? 'call_event' : 'text',
    readAt: data.readAt ? toMillis(data.readAt) : null,
    editedAt: data.editedAt ? toMillis(data.editedAt) : null,
    createdAt: toMillis(data.createdAt),
  };
}

export function subscribeToMessagesFirestore(
  meUid: string,
  peerUid: string,
  onMessages: (messages: ChatMessage[]) => void
): Unsubscribe {
  const pairId = getPairId(meUid, peerUid);
  const path = `conversations/${pairId}/messages`;
  const msgsQuery = query(
    collection(db, 'conversations', pairId, 'messages'),
    where('participants', 'array-contains', meUid)
  );

  return onSnapshot(
    msgsQuery,
    (snap) => {
      const list = snap.docs.map((d) => mapMessageDoc(d.data(), d.id));
      list.sort((a, b) => a.createdAt - b.createdAt);
      onMessages(list.slice(-150));
    },
    (err) => {
      handleFirestoreError(err, OperationType.LIST, path);
    }
  );
}

export async function sendMessageFirestore(params: {
  senderId: string;
  recipientId: string;
  body: string;
  replyTo?: { id: string; senderId: string; body: string } | null;
  kind?: 'text' | 'call_event';
}): Promise<ChatMessage> {
  const pairId = await ensureConversationFirestore(params.senderId, params.recipientId);
  const msgId = crypto.randomUUID();
  const msgRef = doc(db, 'conversations', pairId, 'messages', msgId);
  const cleanBody = params.body.trim().slice(0, 4000);
  const kind = params.kind || 'text';

  try {
    await setDoc(msgRef, {
      id: msgId,
      senderId: params.senderId,
      recipientId: params.recipientId,
      participants: [params.senderId, params.recipientId].sort(),
      body: cleanBody,
      replyToId: params.replyTo?.id || null,
      replyToSenderId: params.replyTo?.senderId || null,
      replyToBody: params.replyTo ? params.replyTo.body.slice(0, 500) : null,
      reactions: {},
      kind,
      readAt: null,
      editedAt: null,
      createdAt: serverTimestamp(),
    });

    await updateDoc(doc(db, 'conversations', pairId), {
      updatedAt: serverTimestamp(),
    }).catch(() => {});

    return {
      id: msgId,
      senderId: params.senderId,
      recipientId: params.recipientId,
      body: cleanBody,
      replyToId: params.replyTo?.id || null,
      replyTo: params.replyTo || null,
      reactions: {},
      kind,
      readAt: null,
      editedAt: null,
      createdAt: Date.now(),
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `conversations/${pairId}/messages/${msgId}`);
  }
}

export async function editMessageFirestore(
  meUid: string,
  peerUid: string,
  messageId: string,
  body: string
): Promise<void> {
  const pairId = getPairId(meUid, peerUid);
  const path = `conversations/${pairId}/messages/${messageId}`;
  try {
    await updateDoc(doc(db, 'conversations', pairId, 'messages', messageId), {
      body: body.trim().slice(0, 4000),
      editedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function toggleReactionFirestore(
  meUid: string,
  peerUid: string,
  messageId: string,
  emoji: string,
  currentReactions: Record<string, string[]>
): Promise<void> {
  const pairId = getPairId(meUid, peerUid);
  const path = `conversations/${pairId}/messages/${messageId}`;
  const next: Record<string, string[]> = { ...currentReactions };
  const users = Array.isArray(next[emoji]) ? next[emoji] : [];
  if (users.includes(meUid)) {
    const filtered = users.filter((u) => u !== meUid);
    if (filtered.length === 0) {
      delete next[emoji];
    } else {
      next[emoji] = filtered;
    }
  } else {
    next[emoji] = [...users, meUid];
  }

  try {
    await updateDoc(doc(db, 'conversations', pairId, 'messages', messageId), {
      reactions: next,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function markMessagesReadFirestore(
  meUid: string,
  peerUid: string,
  unreadMessageIds: string[]
): Promise<void> {
  if (unreadMessageIds.length === 0) return;
  const pairId = getPairId(meUid, peerUid);
  try {
    const batch = writeBatch(db);
    for (const mid of unreadMessageIds.slice(0, 50)) {
      batch.update(doc(db, 'conversations', pairId, 'messages', mid), {
        readAt: serverTimestamp(),
      });
    }
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `conversations/${pairId}/messages`);
  }
}

export async function deleteMessageFirestore(
  meUid: string,
  peerUid: string,
  messageId: string
): Promise<void> {
  const pairId = getPairId(meUid, peerUid);
  const path = `conversations/${pairId}/messages/${messageId}`;
  try {
    await deleteDoc(doc(db, 'conversations', pairId, 'messages', messageId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export function subscribeToCallsFirestore(
  uid: string,
  onCalls: (calls: CallLogItem[]) => void
): Unsubscribe {
  const callsQuery = query(
    collection(db, 'calls'),
    where('participants', 'array-contains', uid)
  );

  return onSnapshot(
    callsQuery,
    async (snap) => {
      try {
        const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
        const peerIds = Array.from(
          new Set(
            docs
              .map(({ data }) =>
                data.callerId === uid ? String(data.calleeId) : String(data.callerId)
              )
              .filter(Boolean)
          )
        );
        const peerMap = new Map<string, PublicUser>();
        await Promise.all(
          peerIds.map(async (pid) => {
            try {
              const p = await getUserProfileFirestore(pid);
              if (p) peerMap.set(pid, p);
            } catch {
              // ignore
            }
          })
        );

        const list: CallLogItem[] = [];
        for (const { id, data } of docs) {
          const callerId = String(data.callerId || '');
          const calleeId = String(data.calleeId || '');
          const peerId = callerId === uid ? calleeId : callerId;
          const peer = peerMap.get(peerId);
          if (!peer) continue;
          list.push({
            id,
            callerId,
            calleeId,
            peer,
            direction: callerId === uid ? 'outgoing' : 'incoming',
            callType: data.callType === 'video' ? 'video' : 'voice',
            status: (data.status as CallStatus) || 'ended',
            startedAt: toMillis(data.startedAt),
            answeredAt: data.answeredAt ? toMillis(data.answeredAt) : null,
            endedAt: data.endedAt ? toMillis(data.endedAt) : null,
            durationSec: typeof data.durationSec === 'number' ? data.durationSec : 0,
          });
        }
        list.sort((a, b) => b.startedAt - a.startedAt);
        onCalls(list.slice(0, 60));
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, 'calls');
      }
    },
    (err) => {
      handleFirestoreError(err, OperationType.LIST, 'calls');
    }
  );
}

export async function createCallRecordFirestore(params: {
  id: string;
  callerId: string;
  calleeId: string;
  callType: CallType;
}): Promise<void> {
  const path = `calls/${params.id}`;
  try {
    await setDoc(doc(db, 'calls', params.id), {
      id: params.id,
      callerId: params.callerId,
      calleeId: params.calleeId,
      participants: [params.callerId, params.calleeId].sort(),
      callType: params.callType,
      status: 'ringing',
      startedAt: serverTimestamp(),
      answeredAt: null,
      endedAt: null,
      durationSec: 0,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function updateCallRecordFirestore(params: {
  callId: string;
  status: 'active' | 'ended' | 'missed' | 'declined';
  durationSec?: number;
}): Promise<void> {
  const path = `calls/${params.callId}`;
  try {
    if (params.status === 'active') {
      await updateDoc(doc(db, 'calls', params.callId), {
        status: 'active',
        answeredAt: serverTimestamp(),
      });
    } else {
      await updateDoc(doc(db, 'calls', params.callId), {
        status: params.status,
        endedAt: serverTimestamp(),
        durationSec: Math.max(0, Math.round(params.durationSec || 0)),
      });
    }
  } catch {
    // Ignore if call doc wasn't created in Firestore (e.g. mixed local/google call)
  }
}
