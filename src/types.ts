export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  avatarColor: string;
  createdAt: number;
  online?: boolean;
  inCall?: boolean;
  authProvider?: 'local' | 'google';
}

export interface FriendItem extends PublicUser {
  friendshipId: string;
  online: boolean;
  inCall: boolean;
  unreadCount: number;
  lastMessage: ChatMessage | null;
}

export interface FriendRequestItem {
  friendshipId: string;
  user: PublicUser;
  createdAt: number;
}

export interface SearchUserItem extends PublicUser {
  relationship: 'none' | 'friends' | 'incoming_pending' | 'outgoing_pending';
  friendshipId: string | null;
}

export interface ReplyPreview {
  id: string;
  senderId: string;
  body: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  recipientId: string;
  body: string;
  replyToId: string | null;
  replyTo: ReplyPreview | null;
  reactions: Record<string, string[]>;
  kind: 'text' | 'call_event';
  readAt: number | null;
  editedAt?: number | null;
  createdAt: number;
}

export type CallType = 'voice' | 'video';
export type CallStatus = 'ringing' | 'active' | 'ended' | 'missed' | 'declined';

export interface CallLogItem {
  id: string;
  callerId: string;
  calleeId: string;
  peer: PublicUser;
  direction: 'outgoing' | 'incoming';
  callType: CallType;
  status: CallStatus;
  startedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  durationSec: number;
}

export interface ActiveCallSession {
  callId: string;
  peer: PublicUser;
  direction: 'outgoing' | 'incoming';
  callType: CallType;
  phase: 'ringing' | 'connecting' | 'connected';
  startedAt: number;
  connectedAt: number | null;
  audioEnabled: boolean;
  videoEnabled: boolean;
  peerAudioEnabled: boolean;
  peerVideoEnabled: boolean;
  mediaNotice: string | null;
}
