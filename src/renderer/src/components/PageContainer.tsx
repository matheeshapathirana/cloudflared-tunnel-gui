import * as React from 'react'
import { cn } from '@renderer/lib/utils'

/**
 * Fluid page wrapper: fills the window, centres on very wide screens, and tightens its
 * padding on small windows. Pages can narrow it (e.g. `max-w-4xl`) for single-column content.
 */
export function PageContainer({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-4 sm:p-6 lg:p-8',
        className
      )}
    >
      {children}
    </div>
  )
}
