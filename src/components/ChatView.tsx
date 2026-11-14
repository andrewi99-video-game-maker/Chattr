import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Info,
  Phone,
  Reply,
  Send,
  Smile,
  Trash2,
  UserMinus,
  Video,
  X,
} from 'lucide-react';
import type { CallType, ChatMessage, FriendItem, PublicUser } from '../types.ts';
import { Avatar } from './Avatar.tsx';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🔥', '🎉', '🙏'];

interface ChatViewProps {
  currentUser: PublicUser;
  friend: FriendItem;
  messages: ChatMessage[];
  loading: boolean;
  isTyping: boolean;
  onBackMobile: () => void;
  onSendMessage: (body: string, replyToId?: string | null) => Promise<void>;
  onReactMessage: (messageId: string, emoji: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onTypingChange: (typing: boolean) => void;
  onStartCall: (friend: FriendItem, callType: CallType) => void;
  onRemoveFriend: (friendId: string) => Promise<void>;
}

function formatMessageTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDayDivider(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return 'Yesterday';
  }
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function ChatView({
  currentUser,
  friend,
  messages,
  loading,
  isTyping,
  onBackMobile,
  onSendMessage,
  onReactMessage,
  onDeleteMessage,
  onTypingChange,
  onStartCall,
  onRemoveFriend,
}: ChatViewProps) {
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [emojiMenuFor, setEmojiMenuFor] = useState<string | null>(null);
  const [showComposerEmoji, setShowComposerEmoji] = useState(false);
  const [showInfoPanel, setShowInfoPanel] = useState(false);
  const [sending, setSending] = useState(false);

  const scrollEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isTyping, friend.id]);

  useEffect(() => {
    setReplyTo(null);
    setEmojiMenuFor(null);
    setShowComposerEmoji(false);
  }, [friend.id]);

  function handleDraftChange(val: string) {
    setDraft(val);
    onTypingChange(true);
    if (typingTimerRef.current) {
      window.clearTimeout(typingTimerRef.current);
    }
    typingTimerRef.current = window.setTimeout(() => {
      onTypingChange(false);
    }, 1800);
  }

  async function submitMessage(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setSending(true);
    onTypingChange(false);
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    try {
      await onSendMessage(trimmed, replyTo?.id ?? null);
      setDraft('');
      setReplyTo(null);
      setShowComposerEmoji(false);
      textareaRef.current?.focus();
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitMessage();
    }
  }

  const lastOutgoingId = [...messages]
    .reverse()
    .find((m) => m.senderId === currentUser.id && m.kind === 'text')?.id;

  return (
    <div className="flex-1 flex min-w-0 min-h-0 bg-[#FFFFFF]">
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Chat Header */}
        <header className="h-16 px-4 sm:px-6 border-b border-[#E6EBF0] bg-[#FFFFFF] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onBackMobile}
              className="md:hidden min-w-[44px] min-h-[44px] -ml-2 flex items-center justify-center rounded-xl text-[#5D6D7E] hover:bg-[#F4F6F8] cursor-pointer"
              aria-label="Back to conversations"
            >
              <ArrowLeft className="w-5 h-5" strokeWidth={1.6} />
            </button>
            <Avatar
              name={friend.displayName}
              color={friend.avatarColor}
              size="md"
              online={friend.online}
              inCall={friend.inCall}
              showPresence
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-base font-semibold text-[#283747] truncate">
                  {friend.displayName}
                </h2>
                <span className="hidden sm:inline font-mono text-xs text-[#7895B2] truncate">
                  @{friend.username}
                </span>
              </div>
              <div className="text-xs text-[#5D6D7E] truncate">
                {isTyping ? (
                  <span className="text-[#7895B2] font-medium">Typing...</span>
                ) : friend.inCall ? (
                  <span className="text-amber-600 font-medium">In a call</span>
                ) : friend.online ? (
                  <span className="text-emerald-600">Online</span>
                ) : (
                  <span>Offline</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => onStartCall(friend, 'voice')}
              className="min-w-[40px] min-h-[40px] px-3 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747] flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer"
              title="Start voice call"
            >
              <Phone className="w-4 h-4 text-[#7895B2]" strokeWidth={1.6} />
              <span className="hidden lg:inline">Voice Call</span>
            </button>
            <button
              type="button"
              onClick={() => onStartCall(friend, 'video')}
              className="min-w-[40px] min-h-[40px] px-3 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer"
              title="Start video call"
            >
              <Video className="w-4 h-4" strokeWidth={1.6} />
              <span className="hidden lg:inline">Video Call</span>
            </button>
            <button
              type="button"
              onClick={() => setShowInfoPanel((v) => !v)}
              className={`min-w-[40px] min-h-[40px] rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
                showInfoPanel
                  ? 'bg-[#7895B2]/15 text-[#7895B2]'
                  : 'text-[#5D6D7E] hover:bg-[#F4F6F8] hover:text-[#283747]'
              }`}
              aria-label="Toggle friend details"
            >
              <Info className="w-4 h-4" strokeWidth={1.6} />
            </button>
          </div>
        </header>

        {/* Messages Timeline */}
        <div
          className="flex-1 overflow-y-auto chat-scroll px-4 sm:px-6 py-5 bg-[#FFFFFF]"
          onClick={() => setEmojiMenuFor(null)}
        >
          {loading ? (
            <div className="h-full flex items-center justify-center text-sm text-[#5D6D7E]">
              Loading conversation...
            </div>
          ) : messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <div className="w-56 aspect-[4/3] rounded-2xl overflow-hidden border border-[#E6EBF0] bg-[#F4F6F8] mb-5">
                <img
                  src="/src/assets/images/friends_connect_art_1794565021200.jpg"
                  alt="Connected friends illustration"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>
              <h3 className="font-display text-lg font-semibold text-[#283747]">
                {friend.displayName}
              </h3>
              <p className="font-mono text-xs text-[#7895B2] mt-0.5">@{friend.username}</p>
              <p className="text-sm text-[#5D6D7E] mt-2.5 max-w-sm">
                You are connected as friends. Say hello below or start a voice or video call.
              </p>
              <div className="mt-5 flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => void onSendMessage(`Hey ${friend.displayName.split(' ')[0]}!`)}
                  className="h-10 px-4 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white text-xs font-medium transition-colors cursor-pointer"
                >
                  Say Hey
                </button>
                <button
                  type="button"
                  onClick={() => onStartCall(friend, 'voice')}
                  className="h-10 px-4 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <Phone className="w-3.5 h-3.5 text-[#7895B2]" strokeWidth={1.6} />
                  <span>Voice Call</span>
                </button>
              </div>
            </div>
          ) : (
            messages.map((msg, idx) => {
              const prev = idx > 0 ? messages[idx - 1] : null;
              const next = idx < messages.length - 1 ? messages[idx + 1] : null;

              const showDayDivider =
                !prev ||
                new Date(prev.createdAt).toDateString() !== new Date(msg.createdAt).toDateString();

              if (msg.kind === 'call_event') {
                return (
                  <div key={msg.id} className="my-3.5">
                    {showDayDivider && (
                      <div className="flex items-center justify-center my-4">
                        <span className="text-[11px] font-medium text-[#94A3B8]">
                          {formatDayDivider(msg.createdAt)}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-center">
                      <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#F4F6F8] border border-[#E6EBF0] text-xs text-[#5D6D7E] tabular-nums">
                        <Phone className="w-3.5 h-3.5 text-[#7895B2]" strokeWidth={1.6} />
                        <span>{msg.body}</span>
                        <span aria-hidden="true">·</span>
                        <span className="text-[#94A3B8]">{formatMessageTime(msg.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                );
              }

              const isMine = msg.senderId === currentUser.id;
              const groupedWithPrev =
                Boolean(prev) &&
                prev!.kind === 'text' &&
                prev!.senderId === msg.senderId &&
                !showDayDivider &&
                msg.createdAt - prev!.createdAt < 120_000;

              const groupedWithNext =
                Boolean(next) &&
                next!.kind === 'text' &&
                next!.senderId === msg.senderId &&
                new Date(next!.createdAt).toDateString() === new Date(msg.createdAt).toDateString() &&
                next!.createdAt - msg.createdAt < 120_000;

              const reactionEntries = Object.entries(msg.reactions || {}).filter(
                ([, users]) => users.length > 0
              );

              const showTimestamp =
                !groupedWithNext || msg.id === lastOutgoingId || reactionEntries.length > 0;

              const bubbleRadiusClass = isMine
                ? `${groupedWithPrev ? 'rounded-tr-lg' : 'rounded-tr-2xl'} ${
                    groupedWithNext ? 'rounded-br-lg' : 'rounded-br-sm'
                  } rounded-l-2xl`
                : `${groupedWithPrev ? 'rounded-tl-lg' : 'rounded-tl-2xl'} ${
                    groupedWithNext ? 'rounded-bl-lg' : 'rounded-bl-sm'
                  } rounded-r-2xl`;

              return (
                <div key={msg.id} className={groupedWithPrev ? 'mt-1' : 'mt-3.5'}>
                  {showDayDivider && (
                    <div className="flex items-center justify-center my-4">
                      <span className="text-[11px] font-medium text-[#94A3B8]">
                        {formatDayDivider(msg.createdAt)}
                      </span>
                    </div>
                  )}

                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                    className={`group flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`relative flex items-end gap-1.5 max-w-[85%] sm:max-w-[70%] ${
                        isMine ? 'flex-row-reverse' : 'flex-row'
                      }`}
                    >
                      <div
                        className={`${bubbleRadiusClass} px-4 py-2.5 text-sm leading-relaxed break-words ${
                          isMine
                            ? 'bg-[#7895B2] text-white'
                            : 'bg-[#F4F6F8] text-[#283747]'
                        }`}
                      >
                        {msg.replyTo && (
                          <div
                            className={`mb-2 px-2.5 py-1.5 rounded-xl text-xs ${
                              isMine
                                ? 'bg-white/15 text-white/95'
                                : 'bg-[#FFFFFF] border border-[#E6EBF0] text-[#5D6D7E]'
                            }`}
                          >
                            <div className="font-medium opacity-90">
                              {msg.replyTo.senderId === currentUser.id
                                ? 'You'
                                : friend.displayName}
                            </div>
                            <div className="truncate">{msg.replyTo.body}</div>
                          </div>
                        )}
                        <div className="whitespace-pre-wrap">{msg.body}</div>
                      </div>

                      {/* Message hover actions */}
                      <div
                        className={`opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-center gap-0.5 shrink-0 ${
                          emojiMenuFor === msg.id ? 'opacity-100' : ''
                        }`}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEmojiMenuFor((cur) => (cur === msg.id ? null : msg.id));
                          }}
                          className="w-8 h-8 rounded-xl flex items-center justify-center text-[#94A3B8] hover:text-[#283747] hover:bg-[#F4F6F8] cursor-pointer"
                          title="React"
                          aria-label="Add reaction"
                        >
                          <Smile className="w-4 h-4" strokeWidth={1.6} />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setReplyTo(msg);
                            textareaRef.current?.focus();
                          }}
                          className="w-8 h-8 rounded-xl flex items-center justify-center text-[#94A3B8] hover:text-[#283747] hover:bg-[#F4F6F8] cursor-pointer"
                          title="Reply"
                          aria-label="Reply to message"
                        >
                          <Reply className="w-4 h-4" strokeWidth={1.6} />
                        </button>
                        {isMine && (
                          <button
                            type="button"
                            onClick={() => onDeleteMessage(msg.id)}
                            className="w-8 h-8 rounded-xl flex items-center justify-center text-[#94A3B8] hover:text-red-600 hover:bg-red-50 cursor-pointer"
                            title="Delete message"
                            aria-label="Delete message"
                          >
                            <Trash2 className="w-4 h-4" strokeWidth={1.6} />
                          </button>
                        )}
                      </div>

                      {/* Quick reaction popover */}
                      {emojiMenuFor === msg.id && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className={`absolute -top-11 z-20 bg-[#FFFFFF] border border-[#E6EBF0] rounded-xl shadow-[0_2px_8px_rgba(40,55,71,0.08)] px-1.5 py-1 flex items-center gap-1 ${
                            isMine ? 'right-0' : 'left-0'
                          }`}
                        >
                          {QUICK_EMOJIS.map((em) => (
                            <button
                              key={em}
                              type="button"
                              onClick={() => {
                                void onReactMessage(msg.id, em);
                                setEmojiMenuFor(null);
                              }}
                              className="w-8 h-8 rounded-lg hover:bg-[#F4F6F8] flex items-center justify-center text-base cursor-pointer"
                            >
                              {em}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Reactions row */}
                    {reactionEntries.length > 0 && (
                      <div className="flex items-center gap-1 mt-1">
                        {reactionEntries.map(([emoji, users]) => {
                          const iReacted = users.includes(currentUser.id);
                          return (
                            <button
                              key={emoji}
                              type="button"
                              onClick={() => onReactMessage(msg.id, emoji)}
                              className={`px-2 py-0.5 rounded-full text-xs border flex items-center gap-1 transition-colors cursor-pointer tabular-nums ${
                                iReacted
                                  ? 'bg-[#7895B2]/12 border-[#7895B2]/40 text-[#283747]'
                                  : 'bg-[#FFFFFF] border-[#E6EBF0] text-[#5D6D7E] hover:bg-[#F4F6F8]'
                              }`}
                            >
                              <span>{emoji}</span>
                              <span>{users.length}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Timestamp & Read receipt */}
                    {showTimestamp && (
                      <div className="flex items-center gap-1 mt-1 text-[11px] text-[#94A3B8] tabular-nums">
                        <span>{formatMessageTime(msg.createdAt)}</span>
                        {isMine && msg.id === lastOutgoingId && (
                          <>
                            <span aria-hidden="true">·</span>
                            {msg.readAt ? (
                              <span className="inline-flex items-center gap-0.5 text-[#7895B2]">
                                <CheckCheck className="w-3.5 h-3.5" strokeWidth={1.6} />
                                <span>Seen</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-0.5">
                                <Check className="w-3.5 h-3.5" strokeWidth={1.6} />
                                <span>Sent</span>
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </motion.div>
                </div>
              );
            })
          )}

          {isTyping && (
            <div className="flex items-start mt-3">
              <div className="bg-[#F4F6F8] rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#7895B2] animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-[#7895B2] animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-[#7895B2] animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          )}

          <div ref={scrollEndRef} />
        </div>

        {/* Message Composer */}
        <footer className="border-t border-[#E6EBF0] bg-[#FFFFFF] px-4 sm:px-6 py-3 shrink-0">
          {replyTo && (
            <div className="mb-2.5 px-3 py-2 bg-[#F4F6F8] border border-[#E6EBF0] rounded-xl flex items-center justify-between gap-3">
              <div className="min-w-0 text-xs">
                <span className="font-medium text-[#283747]">
                  Replying to {replyTo.senderId === currentUser.id ? 'yourself' : friend.displayName}
                </span>
                <p className="text-[#5D6D7E] truncate mt-0.5">{replyTo.body}</p>
              </div>
              <button
                type="button"
                onClick={() => setReplyTo(null)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-[#5D6D7E] hover:text-[#283747] hover:bg-[#E8EDF2] cursor-pointer shrink-0"
                aria-label="Cancel reply"
              >
                <X className="w-4 h-4" strokeWidth={1.6} />
              </button>
            </div>
          )}

          {showComposerEmoji && (
            <div className="mb-2.5 flex items-center gap-1.5 flex-wrap">
              {['😀', '😂', '❤️', '👍', '🔥', '🎉', '🙌', '👀', '✨', '📞'].map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => {
                    handleDraftChange(draft + em);
                    textareaRef.current?.focus();
                  }}
                  className="w-9 h-9 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] border border-[#E6EBF0] flex items-center justify-center text-base cursor-pointer"
                >
                  {em}
                </button>
              ))}
            </div>
          )}

          <form onSubmit={submitMessage} className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => setShowComposerEmoji((v) => !v)}
              className={`min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                showComposerEmoji
                  ? 'bg-[#7895B2]/15 text-[#7895B2]'
                  : 'bg-[#F4F6F8] text-[#5D6D7E] hover:bg-[#E8EDF2] hover:text-[#283747]'
              }`}
              aria-label="Toggle emoji tray"
            >
              <Smile className="w-5 h-5" strokeWidth={1.6} />
            </button>

            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Message ${friend.displayName}...`}
              className="flex-1 min-h-[44px] max-h-32 py-2.5 px-4 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-2xl text-sm text-[#283747] placeholder:text-[#94A3B8] resize-none focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20"
            />

            <button
              type="submit"
              disabled={!draft.trim() || sending}
              className="min-w-[44px] min-h-[44px] px-4 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] disabled:opacity-45 text-white text-sm font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer shrink-0"
              aria-label="Send message"
            >
              <Send className="w-4 h-4" strokeWidth={1.6} />
              <span className="hidden sm:inline">Send</span>
            </button>
          </form>
        </footer>
      </div>

      {/* Friend Info Side Panel */}
      {showInfoPanel && (
        <aside className="hidden lg:flex w-72 border-l border-[#E6EBF0] bg-[#F4F6F8]/60 flex-col p-6 shrink-0">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-display text-sm font-semibold text-[#283747]">Contact Details</h3>
            <button
              type="button"
              onClick={() => setShowInfoPanel(false)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[#5D6D7E] hover:text-[#283747] hover:bg-[#E8EDF2] cursor-pointer"
            >
              <X className="w-4 h-4" strokeWidth={1.6} />
            </button>
          </div>

          <div className="flex flex-col items-center text-center pb-6 border-b border-[#E6EBF0]">
            <Avatar
              name={friend.displayName}
              color={friend.avatarColor}
              size="xl"
              online={friend.online}
              inCall={friend.inCall}
              showPresence
            />
            <div className="font-display text-base font-semibold text-[#283747] mt-3.5">
              {friend.displayName}
            </div>
            <div className="font-mono text-xs text-[#7895B2] mt-0.5">@{friend.username}</div>
            {friend.bio && <p className="text-xs text-[#5D6D7E] mt-3 leading-relaxed">{friend.bio}</p>}
          </div>

          <div className="py-5 space-y-2.5 border-b border-[#E6EBF0]">
            <button
              type="button"
              onClick={() => onStartCall(friend, 'voice')}
              className="w-full h-10 px-3.5 rounded-xl bg-[#FFFFFF] border border-[#E6EBF0] hover:bg-[#F4F6F8] text-[#283747] text-xs font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Phone className="w-4 h-4 text-[#7895B2]" strokeWidth={1.6} />
              <span>Start Voice Call</span>
            </button>
            <button
              type="button"
              onClick={() => onStartCall(friend, 'video')}
              className="w-full h-10 px-3.5 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white text-xs font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Video className="w-4 h-4" strokeWidth={1.6} />
              <span>Start Video Call</span>
            </button>
          </div>

          <div className="mt-auto pt-4">
            <button
              type="button"
              onClick={() => onRemoveFriend(friend.id)}
              className="w-full h-10 px-3.5 rounded-xl text-xs font-medium text-red-600 hover:bg-red-50 flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <UserMinus className="w-4 h-4" strokeWidth={1.6} />
              <span>Remove Friend</span>
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
