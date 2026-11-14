let ringInterval: number | null = null;
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor) {
      audioCtx = new Ctor();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playTonePair(freqA: number, freqB: number, durationSec: number, gainLevel = 0.045): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainLevel, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
    gain.connect(ctx.destination);

    const oscA = ctx.createOscillator();
    oscA.type = 'sine';
    oscA.frequency.setValueAtTime(freqA, now);
    oscA.connect(gain);
    oscA.start(now);
    oscA.stop(now + durationSec);

    const oscB = ctx.createOscillator();
    oscB.type = 'sine';
    oscB.frequency.setValueAtTime(freqB, now);
    oscB.connect(gain);
    oscB.start(now);
    oscB.stop(now + durationSec);
  } catch {
    // ignore audio autoplay blocks
  }
}

export function playMessageCue(): void {
  playTonePair(587.33, 880, 0.09, 0.025);
}

export function startIncomingRingtone(): void {
  stopCallTones();
  const chime = () => {
    playTonePair(523.25, 659.25, 0.25, 0.045);
    window.setTimeout(() => playTonePair(659.25, 783.99, 0.3, 0.04), 220);
  };
  chime();
  ringInterval = window.setInterval(chime, 2200);
}

export function startOutgoingRingback(): void {
  stopCallTones();
  const pulse = () => {
    playTonePair(440, 480, 0.45, 0.025);
  };
  pulse();
  ringInterval = window.setInterval(pulse, 2600);
}

export function stopCallTones(): void {
  if (ringInterval !== null) {
    window.clearInterval(ringInterval);
    ringInterval = null;
  }
}
