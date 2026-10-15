import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useTunnelLogs } from '../lib/api'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Copy, Download, X, ArrowDown } from 'lucide-react'

interface LogsDialogProps {
  tunnelId: string | null
  tunnelName?: string
  onClose: () => void
}

export function LogsDialog({
  tunnelId,
  tunnelName,
  onClose
}: LogsDialogProps): React.JSX.Element | null {
  const logs = useTunnelLogs(tunnelId)
  const [filterLevel, setFilterLevel] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const logsEndRef = useRef<HTMLDivElement | null>(null)

  const filteredLogs = useMemo(() => {
    return logs.filter((line) => {
      if (searchQuery && !line.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false
      }
      if (filterLevel !== 'all') {
        const lower = line.toLowerCase()
        if (
          filterLevel === 'error' &&
          !lower.includes('"level":"error"') &&
          !lower.includes('err')
        ) {
          return false
        }
        if (
          filterLevel === 'warn' &&
          !lower.includes('"level":"warn"') &&
          !lower.includes('warn')
        ) {
          return false
        }
        if (
          filterLevel === 'info' &&
          !lower.includes('"level":"info"') &&
          !lower.includes('info')
        ) {
          return false
        }
      }
      return true
    })
  }, [logs, searchQuery, filterLevel])

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [filteredLogs, autoScroll])

  if (!tunnelId) return null

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(filteredLogs.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Ignore clipboard error
    }
  }

  const handleExport = (): void => {
    const blob = new Blob([filteredLogs.join('\n')], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${tunnelName || 'tunnel'}-logs.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div className="flex h-[80vh] w-full max-w-4xl flex-col rounded-xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Live Logs</h2>
            <p className="text-xs text-muted-foreground">
              {tunnelName ? `Tunnel: ${tunnelName}` : 'Process Log Stream'}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close logs">
            <X className="h-5 w-5 text-muted-foreground hover:text-foreground" />
          </Button>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-muted/50 px-6 py-3">
          <div className="flex-1 min-w-[200px]">
            <Input
              placeholder="Search in logs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 text-xs bg-muted border-border"
            />
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted p-1 text-xs">
            {(['all', 'info', 'warn', 'error'] as const).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setFilterLevel(lvl)}
                className={`rounded px-2.5 py-1 font-medium capitalize transition-colors ${
                  filterLevel === lvl
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoScroll((prev) => !prev)}
            className={`h-8 gap-1.5 text-xs ${
              autoScroll ? 'border-primary/50 text-primary' : 'text-muted-foreground'
            }`}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Auto-scroll
          </Button>

          <Button variant="outline" size="sm" onClick={handleCopy} className="h-8 gap-1.5 text-xs">
            <Copy className="h-3.5 w-3.5" />
            {copied ? 'Copied!' : 'Copy'}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            className="h-8 gap-1.5 text-xs"
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
        </div>

        {/* Log Viewer Container */}
        <div className="flex-1 overflow-y-auto bg-card p-4 font-mono text-xs text-foreground/80">
          {filteredLogs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              {logs.length === 0 ? 'No logs recorded yet.' : 'No logs match the current filters.'}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredLogs.map((line, idx) => (
                <div
                  key={idx}
                  className={`leading-relaxed break-all rounded px-1.5 py-0.5 ${
                    line.toLowerCase().includes('"error"') || line.toLowerCase().includes('err')
                      ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                      : line.toLowerCase().includes('"warn"')
                        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                        : 'hover:bg-muted/50'
                  }`}
                >
                  {line}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
