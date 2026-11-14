import { useState, type ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';

interface SafeImageProps {
  src: string;
  alt: string;
  className?: string;
  fallback?: ReactNode;
}

export function SafeImage({ src, alt, className = '', fallback }: SafeImageProps) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`w-full h-full bg-[#F4F6F8] flex flex-col items-center justify-center gap-2 text-[#7895B2] p-4 ${className}`}
      >
        {fallback ?? (
          <>
            <div className="w-11 h-11 rounded-2xl bg-[#FFFFFF] border border-[#E6EBF0] flex items-center justify-center">
              <MessageSquare className="w-5 h-5 text-[#7895B2]" strokeWidth={1.6} />
            </div>
            <span className="text-xs font-medium text-[#5D6D7E]">Chattr</span>
          </>
        )}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
