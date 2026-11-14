import { useEffect, useRef, useState } from 'react';

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      theme?: 'light' | 'dark' | 'auto';
      callback?: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
    }
  ) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface CloudflareTurnstileProps {
  siteKey: string | null;
  resetSignal?: number;
  onToken: (token: string | null) => void;
}

const SCRIPT_ID = 'cf-turnstile-script';

export function CloudflareTurnstile({ siteKey, resetSignal = 0, onToken }: CloudflareTurnstileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const [widgetError, setWidgetError] = useState(false);

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    setWidgetError(false);

    function renderWidget() {
      if (cancelled || !containerRef.current || !window.turnstile || !siteKey) return;
      if (widgetIdRef.current) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // ignore
        }
        widgetIdRef.current = null;
      }
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme: 'light',
        callback: (token: string) => {
          setWidgetError(false);
          onTokenRef.current(token);
        },
        'expired-callback': () => onTokenRef.current(null),
        'error-callback': () => {
          setWidgetError(true);
          onTokenRef.current(null);
        },
      });
    }

    if (window.turnstile) {
      renderWidget();
    } else {
      let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
      if (!script) {
        script = document.createElement('script');
        script.id = SCRIPT_ID;
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      const handleLoad = () => renderWidget();
      script.addEventListener('load', handleLoad);
      return () => {
        cancelled = true;
        script?.removeEventListener('load', handleLoad);
        if (widgetIdRef.current && window.turnstile) {
          try {
            window.turnstile.remove(widgetIdRef.current);
          } catch {
            // ignore
          }
          widgetIdRef.current = null;
        }
      };
    }

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // ignore
        }
        widgetIdRef.current = null;
      }
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetSignal > 0 && widgetIdRef.current && window.turnstile) {
      try {
        setWidgetError(false);
        window.turnstile.reset(widgetIdRef.current);
      } catch {
        // ignore
      }
      onTokenRef.current(null);
    }
  }, [resetSignal]);

  if (!siteKey) return null;

  return (
    <div className="pt-1 flex flex-col items-center gap-1.5">
      <div ref={containerRef} />
      {widgetError && (
        <p className="text-xs text-red-600 text-center">
          Security widget failed to load. Confirm this domain is listed in Cloudflare Turnstile Hostname Management.
        </p>
      )}
    </div>
  );
}
