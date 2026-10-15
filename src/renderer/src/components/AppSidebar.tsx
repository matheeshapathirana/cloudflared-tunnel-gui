import * as React from 'react'
import { Radio, Zap, Settings } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

export type PageId = 'tunnels' | 'quick-share' | 'settings'

interface NavItem {
  id: PageId
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const NAV_ITEMS: NavItem[] = [
  { id: 'tunnels', label: 'Tunnels', icon: Radio },
  { id: 'quick-share', label: 'Quick share', icon: Zap },
  { id: 'settings', label: 'Settings', icon: Settings }
]

interface AppSidebarProps {
  activePage: PageId
  onSelectPage: (page: PageId) => void
  className?: string
}

export function AppSidebar({
  activePage,
  onSelectPage,
  className
}: AppSidebarProps): React.JSX.Element {
  return (
    <aside
      className={cn(
        'w-60 shrink-0 border-r border-border bg-card/50 flex flex-col justify-between p-3 select-none',
        className
      )}
      aria-label="Sidebar navigation"
    >
      <div className="flex flex-col gap-4">
        {/* App Title */}
        <div className="flex items-center gap-2.5 px-3 py-3 rounded-lg bg-card border border-border/50 shadow-xs">
          <div className="flex items-center justify-center size-8 rounded-md bg-primary text-primary-foreground">
            <Radio className="size-4.5" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-semibold text-sm leading-tight truncate">Cloudflared Tunnel</span>
            <span className="text-xs text-muted-foreground leading-tight truncate">
              GUI Manager
            </span>
          </div>
        </div>

        {/* Navigation Items */}
        <nav className="flex flex-col gap-1" role="navigation" aria-label="Main Navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const isActive = activePage === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectPage(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors text-left cursor-pointer',
                  isActive
                    ? 'bg-secondary text-secondary-foreground shadow-xs'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground'
                )}
              >
                <Icon
                  className={cn('size-4.5', isActive ? 'text-primary' : 'text-muted-foreground')}
                />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
      </div>

      <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border/50">
        Phase 1 Skeleton
      </div>
    </aside>
  )
}
