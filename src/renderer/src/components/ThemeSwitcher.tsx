import * as React from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useSettings, useSetSettings } from '@renderer/lib/api'
import type { ThemePreference } from '@shared/schemas'

const OPTIONS: {
  value: ThemePreference
  label: string
  icon: React.ComponentType<{ className?: string }>
}[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon }
]

export function ThemeSwitcher({ className }: { className?: string }): React.JSX.Element {
  const { data: settings } = useSettings()
  const setSettings = useSetSettings()
  // show the choice immediately while the save round-trips
  const current: ThemePreference = setSettings.variables?.theme ?? settings?.theme ?? 'system'

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn(
        'grid grid-cols-3 gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5',
        className
      )}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const selected = current === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => {
              if (!selected) setSettings.mutate({ theme: value })
            }}
            className={cn(
              'flex cursor-pointer items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              selected
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span>{label}</span>
          </button>
        )
      })}
    </div>
  )
}
