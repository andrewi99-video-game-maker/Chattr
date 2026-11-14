import type { NextFunction, Request, Response } from 'express';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function getClientIp(req: Request): string {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) {
    return cfIp.trim();
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

export function isCloudflareTurnstileConfigured(): boolean {
  const siteKey = (process.env.VITE_CLOUDFLARE_TURNSTILE_SITE_KEY || '').trim();
  const secretKey = (process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY || '').trim();
  return Boolean(siteKey && secretKey);
}

export function getTurnstilePublicConfig(req: Request): {
  turnstileEnabled: boolean;
  siteKey: string | null;
  cloudflareEdge: boolean;
} {
  const siteKey = (process.env.VITE_CLOUDFLARE_TURNSTILE_SITE_KEY || '').trim();
  const secretKey = (process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY || '').trim();
  const enabled = Boolean(siteKey && secretKey);
  return {
    turnstileEnabled: enabled,
    siteKey: enabled ? siteKey : null,
    cloudflareEdge: Boolean(req.headers['cf-ray'] || req.headers['cf-connecting-ip']),
  };
}

export async function verifyTurnstileToken(
  token: unknown,
  remoteIp: string
): Promise<{ ok: boolean; error?: string }> {
  const secretKey = (process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY || '').trim();
  const siteKey = (process.env.VITE_CLOUDFLARE_TURNSTILE_SITE_KEY || '').trim();
  if (!secretKey || !siteKey) {
    return { ok: true };
  }

  if (typeof token !== 'string' || !token.trim()) {
    return { ok: false, error: 'Please complete the Cloudflare security check.' };
  }

  try {
    const body = new URLSearchParams();
    body.set('secret', secretKey);
    body.set('response', token.trim());
    if (remoteIp && remoteIp !== 'unknown') {
      body.set('remoteip', remoteIp);
    }

    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (!data.success) {
      return {
        ok: false,
        error: 'Cloudflare security verification failed. Please try again.',
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: 'Unable to verify Cloudflare security check right now.',
    };
  }
}

export function cloudflareSecurityHeaders(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Allow Google signInWithPopup while protecting cross-origin opener access
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  // Allow voice/video calls on self while disabling unneeded browser sensors
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (req.headers['cf-ray']) {
    res.setHeader('X-Edge-Protection', 'Cloudflare');
  }
  next();
}

interface RateBucket {
  timestamps: number[];
}

export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  keyPrefix: string;
  message?: string;
}) {
  const buckets = new Map<string, RateBucket>();

  // Periodic cleanup to avoid unbounded memory growth
  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - options.windowMs;
    for (const [key, bucket] of buckets.entries()) {
      const fresh = bucket.timestamps.filter((t) => t > cutoff);
      if (fresh.length === 0) {
        buckets.delete(key);
      } else {
        bucket.timestamps = fresh;
      }
    }
  }, Math.max(options.windowMs, 30_000));
  cleanupTimer.unref();

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const cutoff = now - options.windowMs;
    const ip = getClientIp(req);
    const key = `${options.keyPrefix}:${ip}`;
    const existing = buckets.get(key);
    const timestamps = existing ? existing.timestamps.filter((t) => t > cutoff) : [];

    res.setHeader('X-RateLimit-Limit', String(options.max));

    if (timestamps.length >= options.max) {
      const oldest = timestamps[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(Math.ceil((oldest + options.windowMs) / 1000)));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: options.message || 'Too many requests. Please wait a moment and try again.',
      });
      return;
    }

    timestamps.push(now);
    buckets.set(key, { timestamps });
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, options.max - timestamps.length)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + options.windowMs) / 1000)));
    next();
  };
}
