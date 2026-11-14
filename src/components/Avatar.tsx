interface AvatarProps {
  name: string;
  color: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  online?: boolean;
  inCall?: boolean;
  showPresence?: boolean;
}

const SIZE_CLASSES: Record<NonNullable<AvatarProps['size']>, string> = {
  xs: 'w-7 h-7 text-[11px] rounded-full',
  sm: 'w-9 h-9 text-xs rounded-full',
  md: 'w-10 h-10 text-sm rounded-full',
  lg: 'w-12 h-12 text-base rounded-full',
  xl: 'w-20 h-20 text-2xl rounded-full',
};

const DOT_SIZES: Record<NonNullable<AvatarProps['size']>, string> = {
  xs: 'w-2 h-2 border',
  sm: 'w-2.5 h-2.5 border-2',
  md: 'w-2.5 h-2.5 border-2',
  lg: 'w-3 h-3 border-2',
  xl: 'w-3.5 h-3.5 border-2',
};

export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({
  name,
  color,
  size = 'md',
  online = false,
  inCall = false,
  showPresence = false,
}: AvatarProps) {
  const baseColor = color || '#7895B2';
  return (
    <div className="relative inline-flex shrink-0 select-none">
      <div
        className={`${SIZE_CLASSES[size]} flex items-center justify-center font-display font-medium text-white tracking-tight`}
        style={{ backgroundColor: baseColor }}
        aria-hidden="true"
      >
        {getInitials(name)}
      </div>
      {showPresence && (online || inCall) && (
        <span
          title={inCall ? 'On a call' : 'Online'}
          className={`absolute bottom-0 right-0 rounded-full border-white ${DOT_SIZES[size]} ${
            inCall ? 'bg-amber-500' : 'bg-emerald-500'
          }`}
        />
      )}
    </div>
  );
}
