import React, { useState, useMemo } from 'react'
import YAML from 'yaml'
import {
  X,
  FileCode,
  ListOrdered,
  History,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
  AlertCircle,
  Save,
  RotateCcw,
  Loader2
} from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import {
  useReadConfig,
  useSaveConfig,
  useValidateYaml,
  useListBackups,
  useRestoreBackup,
  useStartTunnel,
  useStopTunnel,
  useTunnelStatuses
} from '../lib/api'
import type { Tunnel, IngressRule } from '@shared/schemas'

interface IngressEditorDialogProps {
  tunnel: Tunnel | null
  onClose: () => void
}

type TabType = 'rules' | 'yaml' | 'backups'

export function IngressEditorDialog({
  tunnel,
  onClose
}: IngressEditorDialogProps): React.JSX.Element | null {
  const configPath = tunnel?.local?.configPath ?? null
  const { data: configData, isLoading: isConfigLoading } = useReadConfig(configPath)
  const { data: backups = [], isLoading: isBackupsLoading } = useListBackups(configPath)
  const saveMutation = useSaveConfig()
  const validateMutation = useValidateYaml()
  const restoreMutation = useRestoreBackup()
  const startMutation = useStartTunnel()
  const stopMutation = useStopTunnel()
  const statuses = useTunnelStatuses()

  const [activeTab, setActiveTab] = useState<TabType>('rules')
  const [userEditedYaml, setUserEditedYaml] = useState<string | null>(null)
  const rawYaml = userEditedYaml ?? configData?.rawYaml ?? ''
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    error?: string
  } | null>(null)
  const [savedSuccess, setSavedSuccess] = useState(false)

  // Parse YAML document to extract ingress rules while preserving YAML structure
  const parsedDoc = useMemo(() => {
    try {
      return YAML.parseDocument(rawYaml)
    } catch {
      return null
    }
  }, [rawYaml])

  const parsedIngress = useMemo((): IngressRule[] => {
    if (!parsedDoc) return []
    const ingressNode = parsedDoc.get('ingress') as { toJSON?: () => unknown } | null
    if (ingressNode && typeof ingressNode.toJSON === 'function') {
      const json = ingressNode.toJSON()
      if (Array.isArray(json)) return json as IngressRule[]
    }
    return []
  }, [parsedDoc])

  if (!tunnel || !configPath) return null

  const isTunnelRunning =
    statuses[tunnel.id]?.state === 'connected' || statuses[tunnel.id]?.state === 'starting'

  const handleUpdateRules = (newRules: IngressRule[]): void => {
    try {
      const doc = YAML.parseDocument(rawYaml)
      doc.set('ingress', newRules)
      setUserEditedYaml(doc.toString())
      setValidationResult(null)
    } catch {
      // Fallback
    }
  }

  const handleRuleChange = (index: number, field: keyof IngressRule, value: string): void => {
    const next = [...parsedIngress]
    const updated = { ...next[index] }
    if (field === 'hostname' || field === 'path') {
      if (!value.trim()) {
        delete updated[field]
      } else {
        updated[field] = value.trim()
      }
    } else if (field === 'service') {
      updated.service = value.trim()
    }
    next[index] = updated
    handleUpdateRules(next)
  }

  const handleAddRule = (): void => {
    const next = [...parsedIngress]
    // Insert new rule before catch-all
    const catchAllIndex = Math.max(0, next.length - 1)
    const newRule: IngressRule = {
      hostname: 'example.com',
      service: 'http://localhost:8080'
    }
    next.splice(catchAllIndex, 0, newRule)
    handleUpdateRules(next)
  }

  const handleDeleteRule = (index: number): void => {
    if (parsedIngress.length <= 1) return // Must keep at least catch-all
    const next = parsedIngress.filter((_, i) => i !== index)
    handleUpdateRules(next)
  }

  const handleMoveRule = (index: number, direction: 'up' | 'down'): void => {
    const next = [...parsedIngress]
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    // Keep catch-all at the end
    if (targetIndex < 0 || targetIndex >= next.length - 1 || index >= next.length - 1) return
    const temp = next[index]
    next[index] = next[targetIndex]
    next[targetIndex] = temp
    handleUpdateRules(next)
  }

  const handleValidate = async (): Promise<void> => {
    try {
      const res = await validateMutation.mutateAsync({ rawYaml })
      setValidationResult(res)
    } catch (err) {
      setValidationResult({
        valid: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const handleSave = async (): Promise<void> => {
    try {
      await saveMutation.mutateAsync({ configPath, rawYaml })
      setSavedSuccess(true)
      setTimeout(() => setSavedSuccess(false), 2000)

      // If tunnel is active, restart to apply new config
      if (isTunnelRunning) {
        await stopMutation.mutateAsync({ id: tunnel.id })
        await startMutation.mutateAsync({ id: tunnel.id })
      }
      onClose()
    } catch {
      // Error handled by mutation
    }
  }

  const handleRestore = async (backupPath: string): Promise<void> => {
    try {
      await restoreMutation.mutateAsync({ configPath, backupPath })
      setActiveTab('rules')
    } catch {
      // Error handled by mutation
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div className="flex h-[85vh] w-full max-w-4xl flex-col rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-neutral-100">Ingress Rules</h2>
              <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 font-mono">
                {tunnel.name}
              </span>
            </div>
            <p className="text-xs text-neutral-400 font-mono mt-0.5 truncate max-w-xl">
              {configPath}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close dialog">
            <X className="h-5 w-5 text-neutral-400 hover:text-neutral-200" />
          </Button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900/40 px-6 py-2">
          <Button
            variant={activeTab === 'rules' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setActiveTab('rules')}
            className="h-8 gap-1.5 text-xs"
          >
            <ListOrdered className="h-3.5 w-3.5" />
            Rule Editor
          </Button>
          <Button
            variant={activeTab === 'yaml' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setActiveTab('yaml')}
            className="h-8 gap-1.5 text-xs"
          >
            <FileCode className="h-3.5 w-3.5" />
            Raw YAML
          </Button>
          <Button
            variant={activeTab === 'backups' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setActiveTab('backups')}
            className="h-8 gap-1.5 text-xs"
          >
            <History className="h-3.5 w-3.5" />
            Backups ({backups.length})
          </Button>
        </div>

        {/* Body Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {isConfigLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading configuration...
            </div>
          ) : activeTab === 'rules' ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-neutral-400">
                  Requests are matched from top to bottom. The final catch-all rule matches all
                  remaining traffic.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddRule}
                  className="h-8 gap-1.5 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Ingress Rule
                </Button>
              </div>

              <div className="space-y-2.5">
                {parsedIngress.map((rule, idx) => {
                  const isCatchAll = idx === parsedIngress.length - 1
                  return (
                    <div
                      key={idx}
                      className={`flex flex-col gap-2 rounded-lg border p-3 ${
                        isCatchAll
                          ? 'border-neutral-800/80 bg-neutral-900/30'
                          : 'border-neutral-800 bg-neutral-900/70'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-neutral-400">
                          {isCatchAll ? 'Catch-all Rule (Final)' : `Rule #${idx + 1}`}
                        </span>
                        {!isCatchAll && (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={idx === 0}
                              onClick={() => handleMoveRule(idx, 'up')}
                              className="h-6 w-6 text-neutral-400 hover:text-neutral-200"
                              aria-label="Move rule up"
                            >
                              <ArrowUp className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={idx >= parsedIngress.length - 2}
                              onClick={() => handleMoveRule(idx, 'down')}
                              className="h-6 w-6 text-neutral-400 hover:text-neutral-200"
                              aria-label="Move rule down"
                            >
                              <ArrowDown className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDeleteRule(idx)}
                              className="h-6 w-6 text-destructive hover:bg-destructive/10"
                              aria-label="Delete rule"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                        {!isCatchAll ? (
                          <>
                            <div>
                              <label className="text-[10px] uppercase font-bold text-neutral-500 mb-1 block">
                                Public Hostname
                              </label>
                              <Input
                                value={rule.hostname ?? ''}
                                placeholder="app.example.com"
                                onChange={(e) => handleRuleChange(idx, 'hostname', e.target.value)}
                                className="h-8 font-mono text-xs"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] uppercase font-bold text-neutral-500 mb-1 block">
                                Path Pattern (Optional)
                              </label>
                              <Input
                                value={rule.path ?? ''}
                                placeholder="/*"
                                onChange={(e) => handleRuleChange(idx, 'path', e.target.value)}
                                className="h-8 font-mono text-xs"
                              />
                            </div>
                          </>
                        ) : (
                          <div className="md:col-span-2 flex items-center text-xs text-neutral-400 italic">
                            Matches all unspecified hostnames and paths.
                          </div>
                        )}
                        <div>
                          <label className="text-[10px] uppercase font-bold text-neutral-500 mb-1 block">
                            Service URL
                          </label>
                          <Input
                            value={rule.service}
                            placeholder="http://localhost:3000 or http_status:404"
                            onChange={(e) => handleRuleChange(idx, 'service', e.target.value)}
                            className="h-8 font-mono text-xs"
                          />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : activeTab === 'yaml' ? (
            <div className="flex h-full flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-neutral-400">
                  Directly edit config YAML. Comments and key order are preserved.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleValidate}
                  disabled={validateMutation.isPending}
                  className="h-7 text-xs"
                >
                  {validateMutation.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  Validate YAML
                </Button>
              </div>

              {validationResult && (
                <div
                  className={`flex items-start gap-2 rounded-lg border p-2.5 text-xs ${
                    validationResult.valid
                      ? 'border-emerald-800/80 bg-emerald-950/20 text-emerald-300'
                      : 'border-destructive/80 bg-destructive/10 text-destructive'
                  }`}
                >
                  {validationResult.valid ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
                  ) : (
                    <AlertCircle className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
                  )}
                  <div>
                    <span className="font-semibold">
                      {validationResult.valid ? 'YAML is valid!' : 'Validation failed:'}
                    </span>
                    {validationResult.error && (
                      <div className="font-mono text-[11px] mt-0.5">{validationResult.error}</div>
                    )}
                  </div>
                </div>
              )}

              <textarea
                value={rawYaml}
                onChange={(e) => {
                  setUserEditedYaml(e.target.value)
                  setValidationResult(null)
                }}
                className="flex-1 w-full rounded-lg border border-neutral-800 bg-neutral-950 p-4 font-mono text-xs text-neutral-200 outline-none focus:border-neutral-700 resize-none leading-relaxed"
                rows={16}
                spellCheck={false}
              />
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-neutral-400">
                Automatic backups created prior to saves. The last 5 versions are retained.
              </p>
              {isBackupsLoading ? (
                <div className="py-8 text-center text-xs text-neutral-500">Loading backups...</div>
              ) : backups.length === 0 ? (
                <div className="py-8 text-center text-xs text-neutral-500">
                  No backups recorded yet for this configuration.
                </div>
              ) : (
                <div className="space-y-2">
                  {backups.map((b) => (
                    <div
                      key={b.fileName}
                      className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/60 p-3"
                    >
                      <div>
                        <div className="font-mono text-xs text-neutral-200">{b.fileName}</div>
                        <div className="text-[11px] text-neutral-500 mt-0.5">
                          {new Date(b.timestamp).toLocaleString()} &bull;{' '}
                          {(b.size / 1024).toFixed(1)} KB
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={restoreMutation.isPending}
                        onClick={() => handleRestore(b.path)}
                        className="h-8 gap-1.5 text-xs"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Restore
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-neutral-800 px-6 py-3.5 bg-neutral-950">
          <div className="text-xs text-neutral-400">
            {isTunnelRunning && (
              <span className="text-amber-400 font-medium">
                &bull; Saving will automatically restart the live tunnel.
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={saveMutation.isPending}
              onClick={handleSave}
              className="gap-1.5"
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : savedSuccess ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {savedSuccess ? 'Saved' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
