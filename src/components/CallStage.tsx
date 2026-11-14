import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Phone,
  PhoneOff,
  Shield,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react';
import type { ActiveCallSession, CallType, PublicUser } from '../types.ts';
import { Avatar } from './Avatar.tsx';

interface IncomingCallData {
  callId: string;
  caller: PublicUser;
  callType: CallType;
}

interface CallStageProps {
  incomingCall: IncomingCallData | null;
  activeCall: ActiveCallSession | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  onAcceptIncoming: () => void;
  onDeclineIncoming: () => void;
  onEndCall: () => void;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
}

function formatTimer(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const BAR_COUNT = 24;

function AudioWaveVisualizer({
  remoteStream,
  localStream,
  active,
}: {
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  active: boolean;
}) {
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0.18));

  useEffect(() => {
    const stream =
      remoteStream && remoteStream.getAudioTracks().length > 0
        ? remoteStream
        : localStream && localStream.getAudioTracks().length > 0
        ? localStream
        : null;

    let rafId = 0;
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let dataArray: Uint8Array<ArrayBuffer> | null = null;

    if (stream && active) {
      try {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctor) {
          ctx = new Ctor();
          const source = ctx.createMediaStreamSource(stream);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 64;
          source.connect(analyser);
          dataArray = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        }
      } catch {
        analyser = null;
      }
    }

    let phase = 0;
    const tick = () => {
      phase += 0.08;
      if (analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray);
        const next: number[] = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          const binIdx = Math.min(dataArray.length - 1, Math.floor((i / BAR_COUNT) * 18) + 1);
          const norm = dataArray[binIdx] / 255;
          const idle = 0.14 + 0.06 * Math.sin(phase + i * 0.45);
          next.push(Math.max(idle, Math.min(1, norm * 1.15)));
        }
        setLevels(next);
      } else {
        const next: number[] = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          const wave = 0.16 + 0.12 * Math.sin(phase + i * 0.42) * Math.cos(phase * 0.5 + i * 0.2);
          next.push(Math.max(0.12, Math.abs(wave)));
        }
        setLevels(next);
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
      if (ctx) {
        ctx.close().catch(() => {});
      }
    };
  }, [remoteStream, localStream, active]);

  return (
    <div className="flex items-center justify-center gap-1 h-12 px-4" aria-hidden="true">
      {levels.map((lvl, idx) => (
        <span
          key={idx}
          className="w-1 h-10 rounded-full bg-[#7895B2] origin-center transition-transform duration-75"
          style={{ transform: `scaleY(${lvl.toFixed(3)})` }}
        />
      ))}
    </div>
  );
}

export function CallStage({
  incomingCall,
  activeCall,
  localStream,
  remoteStream,
  onAcceptIncoming,
  onDeclineIncoming,
  onEndCall,
  onToggleAudio,
  onToggleVideo,
}: CallStageProps) {
  const [minimized, setMinimized] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!activeCall) {
      setMinimized(false);
      setElapsedSec(0);
      return;
    }
    if (activeCall.phase !== 'connected' || !activeCall.connectedAt) {
      setElapsedSec(0);
      return;
    }
    const update = () => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - activeCall.connectedAt!) / 1000)));
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [activeCall?.callId, activeCall?.phase, activeCall?.connectedAt]);

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, minimized, activeCall?.callId, activeCall?.videoEnabled]);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current.play().catch(() => {});
    }
  }, [remoteStream, minimized, activeCall?.callId]);

  if (incomingCall && !activeCall) {
    return (
      <div className="fixed inset-0 z-50 bg-[#283747]/30 backdrop-blur-[2px] flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-sm bg-[#FFFFFF] text-[#283747] border border-[#E6EBF0] rounded-3xl p-7 text-center shadow-[0_12px_32px_rgba(40,55,71,0.12)]"
        >
          <div className="flex justify-center">
            <div className="p-1.5 rounded-full bg-[#F4F6F8] border border-[#E6EBF0]">
              <Avatar
                name={incomingCall.caller.displayName}
                color={incomingCall.caller.avatarColor}
                size="xl"
              />
            </div>
          </div>
          <h2 className="font-display text-xl font-semibold mt-4 text-[#283747]">
            {incomingCall.caller.displayName}
          </h2>
          <p className="font-mono text-xs text-[#7895B2] mt-0.5">@{incomingCall.caller.username}</p>
          <p className="text-sm text-[#5D6D7E] mt-3">
            Incoming {incomingCall.callType === 'video' ? 'video' : 'voice'} call
          </p>

          <div className="mt-7 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={onDeclineIncoming}
              className="h-12 rounded-2xl bg-[#F4F6F8] hover:bg-red-50 text-red-600 text-sm font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <PhoneOff className="w-4 h-4" strokeWidth={1.6} />
              <span>Decline</span>
            </button>
            <button
              type="button"
              onClick={onAcceptIncoming}
              className="h-12 rounded-2xl bg-[#7895B2] hover:bg-[#6684A2] text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              {incomingCall.callType === 'video' ? (
                <Video className="w-4 h-4" strokeWidth={1.6} />
              ) : (
                <Phone className="w-4 h-4" strokeWidth={1.6} />
              )}
              <span>Accept</span>
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  if (!activeCall) return null;

  const hasRemoteVideo =
    activeCall.callType === 'video' &&
    activeCall.peerVideoEnabled &&
    remoteStream &&
    remoteStream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled);

  const audioElement = <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />;

  if (minimized) {
    return (
      <>
        {audioElement}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-20 md:bottom-5 right-5 z-40 bg-[#FFFFFF] text-[#283747] border border-[#E6EBF0] rounded-2xl px-4 py-3 shadow-[0_6px_20px_rgba(40,55,71,0.08)] flex items-center gap-4"
        >
          <Avatar name={activeCall.peer.displayName} color={activeCall.peer.avatarColor} size="sm" />
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate max-w-[140px]">
              {activeCall.peer.displayName}
            </div>
            <div className="font-mono text-xs text-[#7895B2] tabular-nums">
              {activeCall.phase === 'connected'
                ? formatTimer(elapsedSec)
                : activeCall.phase === 'ringing'
                ? 'Ringing...'
                : 'Connecting...'}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onToggleAudio}
              className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
                activeCall.audioEnabled
                  ? 'bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747]'
                  : 'bg-red-50 text-red-600'
              }`}
              title={activeCall.audioEnabled ? 'Mute mic' : 'Unmute mic'}
            >
              {activeCall.audioEnabled ? (
                <Mic className="w-4 h-4" strokeWidth={1.6} />
              ) : (
                <MicOff className="w-4 h-4" strokeWidth={1.6} />
              )}
            </button>
            <button
              type="button"
              onClick={() => setMinimized(false)}
              className="w-9 h-9 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747] flex items-center justify-center transition-colors cursor-pointer"
              title="Expand call view"
            >
              <Maximize2 className="w-4 h-4" strokeWidth={1.6} />
            </button>
            <button
              type="button"
              onClick={onEndCall}
              className="w-9 h-9 rounded-xl bg-red-600 hover:bg-red-700 text-white flex items-center justify-center transition-colors cursor-pointer"
              title="End call"
            >
              <PhoneOff className="w-4 h-4" strokeWidth={1.6} />
            </button>
          </div>
        </motion.div>
      </>
    );
  }

  return (
    <>
      {audioElement}
      <div className="fixed inset-0 z-50 bg-[#283747]/35 backdrop-blur-xs flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-3xl bg-[#FFFFFF] text-[#283747] border border-[#E6EBF0] rounded-3xl overflow-hidden shadow-[0_16px_40px_rgba(40,55,71,0.12)] flex flex-col"
        >
          {/* Top Call Bar */}
          <div className="px-6 py-4 border-b border-[#E6EBF0] flex items-center justify-between gap-4 bg-[#FFFFFF]">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span className="font-display text-base font-semibold truncate text-[#283747]">
                  {activeCall.peer.displayName}
                </span>
                <span className="font-mono text-xs text-[#7895B2]">@{activeCall.peer.username}</span>
              </div>
              <div className="font-mono text-xs text-[#5D6D7E] mt-0.5 flex items-center gap-2 tabular-nums">
                <span>{activeCall.callType === 'video' ? 'Video Call' : 'Voice Call'}</span>
                <span aria-hidden="true">·</span>
                <span className="text-[#7895B2] font-medium">
                  {activeCall.phase === 'connected'
                    ? formatTimer(elapsedSec)
                    : activeCall.phase === 'ringing'
                    ? 'Ringing...'
                    : 'Connecting...'}
                </span>
                {activeCall.phase === 'connected' && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1 text-emerald-600">
                      <Shield className="w-3 h-3" strokeWidth={1.6} />
                      <span>Peer-to-Peer</span>
                    </span>
                  </>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setMinimized(true)}
              className="min-h-[40px] px-3.5 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-xs font-medium text-[#283747] flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
            >
              <Minimize2 className="w-4 h-4 text-[#7895B2]" strokeWidth={1.6} />
              <span>Minimize to Chat</span>
            </button>
          </div>

          {activeCall.mediaNotice && (
            <div className="px-6 py-2.5 bg-amber-50 border-b border-amber-200 text-xs text-amber-800 flex items-center gap-2">
              <Volume2 className="w-4 h-4 shrink-0" strokeWidth={1.6} />
              <span>{activeCall.mediaNotice}</span>
            </div>
          )}

          {/* Video / Voice Stage */}
          <div
            className={`relative h-[340px] sm:h-[420px] flex items-center justify-center overflow-hidden ${
              hasRemoteVideo ? 'bg-[#283747]' : 'bg-[#F4F6F8]'
            }`}
          >
            {hasRemoteVideo ? (
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="relative flex flex-col items-center text-center px-6">
                <div className="p-2 rounded-full bg-[#FFFFFF] border border-[#E6EBF0]">
                  <Avatar
                    name={activeCall.peer.displayName}
                    color={activeCall.peer.avatarColor}
                    size="xl"
                  />
                </div>
                <div className="font-display text-xl font-semibold mt-4 text-[#283747]">
                  {activeCall.peer.displayName}
                </div>
                <div className="text-sm text-[#5D6D7E] mt-1 tabular-nums">
                  {activeCall.phase === 'connected'
                    ? activeCall.peerAudioEnabled
                      ? 'Voice connected'
                      : 'Peer microphone muted'
                    : activeCall.phase === 'ringing'
                    ? 'Waiting for answer...'
                    : 'Establishing peer connection...'}
                </div>

                <div className="mt-5">
                  <AudioWaveVisualizer
                    remoteStream={remoteStream}
                    localStream={localStream}
                    active={activeCall.phase === 'connected'}
                  />
                </div>
              </div>
            )}

            {/* Local self-preview when video is enabled */}
            {activeCall.callType === 'video' && activeCall.videoEnabled && localStream && (
              <div className="absolute bottom-4 right-4 w-32 sm:w-44 aspect-video rounded-2xl overflow-hidden border border-[#E6EBF0] bg-[#283747] shadow-[0_4px_12px_rgba(40,55,71,0.16)]">
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-cover -scale-x-100"
                />
              </div>
            )}
          </div>

          {/* Call Controls */}
          <div className="px-6 py-5 bg-[#FFFFFF] border-t border-[#E6EBF0] flex items-center justify-center gap-4">
            <button
              type="button"
              onClick={onToggleAudio}
              className={`min-w-[52px] h-12 px-4 rounded-2xl flex items-center justify-center gap-2 text-sm font-medium transition-colors cursor-pointer ${
                activeCall.audioEnabled
                  ? 'bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747]'
                  : 'bg-red-50 border border-red-200 text-red-600'
              }`}
              title={activeCall.audioEnabled ? 'Mute microphone' : 'Unmute microphone'}
            >
              {activeCall.audioEnabled ? (
                <Mic className="w-5 h-5 text-[#7895B2]" strokeWidth={1.6} />
              ) : (
                <MicOff className="w-5 h-5" strokeWidth={1.6} />
              )}
              <span className="hidden sm:inline">{activeCall.audioEnabled ? 'Mute' : 'Muted'}</span>
            </button>

            {activeCall.callType === 'video' && (
              <button
                type="button"
                onClick={onToggleVideo}
                className={`min-w-[52px] h-12 px-4 rounded-2xl flex items-center justify-center gap-2 text-sm font-medium transition-colors cursor-pointer ${
                  activeCall.videoEnabled
                    ? 'bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747]'
                    : 'bg-red-50 border border-red-200 text-red-600'
                }`}
                title={activeCall.videoEnabled ? 'Turn camera off' : 'Turn camera on'}
              >
                {activeCall.videoEnabled ? (
                  <Video className="w-5 h-5 text-[#7895B2]" strokeWidth={1.6} />
                ) : (
                  <VideoOff className="w-5 h-5" strokeWidth={1.6} />
                )}
                <span className="hidden sm:inline">
                  {activeCall.videoEnabled ? 'Camera' : 'Camera Off'}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={onEndCall}
              className="h-12 px-6 rounded-2xl bg-red-600 hover:bg-red-700 text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <PhoneOff className="w-5 h-5" strokeWidth={1.6} />
              <span>End Call</span>
            </button>
          </div>
        </motion.div>
      </div>
    </>
  );
}
