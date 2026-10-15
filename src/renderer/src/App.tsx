import { useState, useEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/api'
import { TooltipProvider } from './components/ui/tooltip'
import { AppSidebar, type PageId } from './components/AppSidebar'
import { BinaryBanner } from './components/BinaryBanner'
import { TunnelsPage } from './pages/TunnelsPage'
import { QuickSharePage } from './pages/QuickSharePage'
import { SettingsPage } from './pages/SettingsPage'

function AppContent(): React.JSX.Element {
  const [activePage, setActivePage] = useState<PageId>('tunnels')

  // the tray menu can ask for a specific page (e.g. "Quick share…")
  useEffect(() => window.api.on('app:navigate', (page) => setActivePage(page)), [])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const updateTheme = (e: MediaQueryListEvent | MediaQueryList): void => {
      if (e.matches) {
        document.documentElement.classList.add('dark')
      } else {
        document.documentElement.classList.remove('dark')
      }
    }

    updateTheme(mediaQuery)

    const handler = (e: MediaQueryListEvent): void => updateTheme(e)
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <AppSidebar activePage={activePage} onSelectPage={setActivePage} />

      <main className="flex flex-1 flex-col overflow-hidden min-w-0">
        <BinaryBanner onGoToSettings={() => setActivePage('settings')} />
        <div className="flex-1 overflow-y-auto">
          {activePage === 'tunnels' && (
            <TunnelsPage onNavigateToSettings={() => setActivePage('settings')} />
          )}
          {activePage === 'quick-share' && <QuickSharePage />}
          {activePage === 'settings' && <SettingsPage />}
        </div>
      </main>
    </div>
  )
}

export default function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <AppContent />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
