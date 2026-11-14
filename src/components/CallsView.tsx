import { useMemo, useState } from 'react';
import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from 'lucide-react';
import { CHATTR_ASSETS } from '../lib/assets.ts';
import type { CallLogItem, CallType, PublicUser } from '../types.ts';
import { Avatar } from './Avatar.tsx';
import { SafeImage } from './SafeImage.tsx';

interface CallsViewProps {
  calls: CallLogItem[];
  onlineMap: Record<string, boolean>;
  onStartCall: (peer: PublicUser, callType: CallType) => void;
  onOpenChat: (peerId: string) => void;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function CallsView({ calls, onlineMap, onStartCall, onOpenChat }: CallsViewProps) {
  const [filter, setFilter] = useState<'all' | 'missed'>('all');

  const filteredCalls = useMemo(() => {
    if (filter === 'missed') {
      return calls.filter((c) => c.status === 'missed' || c.status === 'declined');
    }
    return calls;
  }, [calls, filter]);

  return (
    <div className="flex-1 flex flex-col bg-[#FFFFFF] min-h-0">
      <div className="px-6 py-5 border-b border-[#E6EBF0] flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-[#283747]">Call History</h1>
          <p className="text-sm text-[#5D6D7E] mt-0.5">
            Recent voice and video calls with friends
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-[#F4F6F8] rounded-xl">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                filter === 'all'
                  ? 'bg-[#FFFFFF] text-[#283747] shadow-[0_1px_2px_rgba(40,55,71,0.05)]'
                  : 'text-[#5D6D7E] hover:text-[#283747]'
              }`}
            >
              All ({calls.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter('missed')}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                filter === 'missed'
                  ? 'bg-[#FFFFFF] text-[#283747] shadow-[0_1px_2px_rgba(40,55,71,0.05)]'
                  : 'text-[#5D6D7E] hover:text-[#283747]'
              }`}
            >
              Missed
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto chat-scroll">
        {filteredCalls.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center p-8 text-center">
            <div className="w-56 aspect-[4/3] rounded-2xl overflow-hidden border border-[#E6EBF0] bg-[#F4F6F8] mb-5">
              <SafeImage
                src={CHATTR_ASSETS.emptyChatArtwork}
                alt="Voice and video calling artwork"
                className="w-full h-full object-cover"
              />
            </div>
            <h2 className="font-display text-base font-semibold text-[#283747]">
              {filter === 'missed' ? 'No missed calls' : 'No calls yet'}
            </h2>
            <p className="text-sm text-[#5D6D7E] mt-1 max-w-sm">
              {filter === 'missed'
                ? 'You have no missed or declined calls.'
                : 'Start a voice or video call from any friend conversation and your call history will appear here.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#F4F6F8]">
            {filteredCalls.map((call) => {
              const isMissedOrDeclined = call.status === 'missed' || call.status === 'declined';
              const isOnline = Boolean(onlineMap[call.peer.id]);

              return (
                <div
                  key={call.id}
                  className="px-6 py-4 flex items-center justify-between gap-4 hover:bg-[#F4F6F8]/70 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => onOpenChat(call.peer.id)}
                    className="flex items-center gap-3.5 min-w-0 text-left cursor-pointer"
                  >
                    <Avatar
                      name={call.peer.displayName}
                      color={call.peer.avatarColor}
                      size="md"
                      online={isOnline}
                      showPresence
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-semibold truncate ${
                            isMissedOrDeclined && call.direction === 'incoming'
                              ? 'text-red-600'
                              : 'text-[#283747]'
                          }`}
                        >
                          {call.peer.displayName}
                        </span>
                        <span className="font-mono text-xs text-[#7895B2] truncate">
                          @{call.peer.username}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 text-xs text-[#5D6D7E] mt-0.5 tabular-nums">
                        {isMissedOrDeclined ? (
                          <PhoneMissed className="w-3.5 h-3.5 text-red-500 shrink-0" strokeWidth={1.6} />
                        ) : call.direction === 'outgoing' ? (
                          <PhoneOutgoing
                            className="w-3.5 h-3.5 text-[#7895B2] shrink-0"
                            strokeWidth={1.6}
                          />
                        ) : (
                          <PhoneIncoming
                            className="w-3.5 h-3.5 text-emerald-600 shrink-0"
                            strokeWidth={1.6}
                          />
                        )}
                        <span>
                          {call.callType === 'video' ? 'Video' : 'Voice'}
                          {' · '}
                          {call.status === 'ended'
                            ? formatDuration(call.durationSec)
                            : call.status === 'declined'
                            ? 'Declined'
                            : call.status === 'missed'
                            ? call.direction === 'outgoing'
                              ? 'No answer'
                              : 'Missed'
                            : 'Active'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{formatTime(call.startedAt)}</span>
                      </div>
                    </div>
                  </button>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onStartCall(call.peer, 'voice')}
                      className="min-w-[40px] min-h-[40px] px-3 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747] flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer"
                      title="Voice call"
                    >
                      <Phone className="w-4 h-4 text-[#7895B2]" strokeWidth={1.6} />
                      <span className="hidden sm:inline">Voice</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onStartCall(call.peer, 'video')}
                      className="min-w-[40px] min-h-[40px] px-3 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer"
                      title="Video call"
                    >
                      <Video className="w-4 h-4" strokeWidth={1.6} />
                      <span className="hidden sm:inline">Video</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
