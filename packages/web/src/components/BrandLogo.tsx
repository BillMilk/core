import logoUrl from '@/assets/agent-tower-logo.png'
import lockupUrl from '@/assets/agent-tower-lockup.png'

interface BrandLogoProps {
  className?: string
  alt?: string
}

interface BrandLockupProps {
  className?: string
}

export function BrandLogo({ className = 'size-6', alt = 'Agent Tower' }: BrandLogoProps) {
  return (
    <img
      src={logoUrl}
      alt={alt}
      className={`block shrink-0 object-contain ${className}`}
    />
  )
}

export function BrandLockup({ className = 'h-6 w-auto max-[359px]:h-[22px]' }: BrandLockupProps) {
  return (
    <img
      src={lockupUrl}
      alt="Agent Tower"
      className={`block shrink-0 select-none object-contain ${className}`}
    />
  )
}
