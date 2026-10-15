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

interface ThemeSwitcherProps {
  /** `compact`: icon-only buttons (stacked on the narrow sidebar). `labelled`: segmented control with text. */
  variant: 'compact' | 'labelled'
  className?: string
}

export function ThemeSwitcher({ variant, className }: ThemeSwitcherProps): React.JSX.Element {
  const { data: settings } = useSettings()
  const setSettings = useSetSettings()
  // show the choice immediately while the save round-trips
  const current: ThemePreference = setSettings.variables?.theme ?? settings?.theme ?? 'system'
  const labelled = variant === 'labelled'

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn(
        'rounded-lg border border-border bg-muted/40 p-0.5',
        labelled ? 'grid grid-cols-3 gap-0.5' : 'flex flex-col lg:flex-row gap-0.5',
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
              'flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              labelled ? 'px-3 py-2' : 'p-1.5',
              selected
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="size-4 shrink-0" />
            {labelled && <span>{label}</span>}
          </button>
        )
      })}
    </div>
  )
}
