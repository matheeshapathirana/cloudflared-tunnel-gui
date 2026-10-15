import { z } from 'zod'

export const TunnelBaseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  kind: z.enum(['quick', 'remote', 'local']),
  cfTunnelId: z.string().optional(),
  runMode: z.enum(['app', 'service']),
  serviceName: z.string().optional(),
  autoStart: z.boolean(),
  quick: z
    .object({
      target: z.string().min(1)
    })
    .optional(),
  local: z
    .object({
      configPath: z.string().min(1)
    })
    .optional()
})

export const TunnelSchema = TunnelBaseSchema.superRefine((val, ctx) => {
  if (val.kind === 'quick') {
    if (!val.quick?.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Quick tunnels require quick.target',
        path: ['quick', 'target']
      })
    }
    if (val.runMode === 'service') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Quick tunnels cannot run as a service',
        path: ['runMode']
      })
    }
  }

  if (val.kind === 'local') {
    if (!val.local?.configPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Local tunnels require local.configPath',
        path: ['local', 'configPath']
      })
    }
    if (!val.cfTunnelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Local tunnels require cfTunnelId',
        path: ['cfTunnelId']
      })
    }
  }

  if (val.kind === 'remote') {
    if (!val.cfTunnelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Remote tunnels require cfTunnelId',
        path: ['cfTunnelId']
      })
    }
  }

  if (val.runMode === 'service') {
    if (!val.serviceName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Service runMode requires serviceName',
        path: ['serviceName']
      })
    }
  }
})

export type Tunnel = z.infer<typeof TunnelSchema>

export const TunnelStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('stopped') }),
  z.object({ state: z.literal('starting') }),
  z.object({
    state: z.literal('connected'),
    connections: z.number(),
    quickUrl: z.string().optional()
  }),
  z.object({
    state: z.literal('degraded'),
    reason: z.string()
  }),
  z.object({
    state: z.literal('crashed'),
    exitCode: z.number().nullable(),
    lastLines: z.array(z.string())
  }),
  z.object({ state: z.literal('unknown') })
])

export type TunnelStatus = z.infer<typeof TunnelStatusSchema>

export const ThemePreferenceSchema = z.enum(['system', 'light', 'dark'])

export type ThemePreference = z.infer<typeof ThemePreferenceSchema>

export const AppStateSchema = z.object({
  version: z.literal(1),
  tunnels: z.array(TunnelSchema),
  account: z
    .object({
      accountId: z.string(),
      accountName: z.string()
    })
    .optional(),
  binary: z.object({
    overridePath: z.string().optional()
  }),
  startup: z.object({
    launchAtLogin: z.boolean(),
    startHidden: z.boolean()
  }),
  // default keeps state files written before the theme setting existed valid
  theme: ThemePreferenceSchema.default('system'),
  recentQuickTargets: z.array(z.string()),
  runningPids: z.record(z.string(), z.number())
})

export type AppState = z.infer<typeof AppStateSchema>

export function defaultAppState(): AppState {
  return {
    version: 1,
    tunnels: [],
    binary: {},
    startup: {
      launchAtLogin: false,
      startHidden: true
    },
    theme: 'system',
    recentQuickTargets: [],
    runningPids: {}
  }
}

export const BinaryStatusSchema = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    path: z.string(),
    source: z.enum(['override', 'managed', 'path', 'programFiles']),
    version: z.string().nullable(),
    overrideInvalid: z.boolean()
  }),
  z.object({
    found: z.literal(false),
    searched: z.array(z.string()),
    overrideInvalid: z.boolean()
  })
])

export type BinaryStatus = z.infer<typeof BinaryStatusSchema>

export const SettingsViewSchema = z.object({
  startup: z.object({
    launchAtLogin: z.boolean(),
    startHidden: z.boolean()
  }),
  binary: z.object({
    overridePath: z.string().optional()
  }),
  theme: ThemePreferenceSchema,
  appVersion: z.string()
})

export type SettingsView = z.infer<typeof SettingsViewSchema>

export const SettingsPatchSchema = z.object({
  startup: z
    .object({
      launchAtLogin: z.boolean().optional(),
      startHidden: z.boolean().optional()
    })
    .optional(),
  theme: ThemePreferenceSchema.optional()
})

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

export const IngressRuleSchema = z.object({
  hostname: z.string().optional(),
  path: z.string().optional(),
  service: z.string().min(1),
  originRequest: z.record(z.string(), z.unknown()).optional()
})

export type IngressRule = z.infer<typeof IngressRuleSchema>

export const BackupInfoSchema = z.object({
  fileName: z.string(),
  timestamp: z.number(),
  path: z.string(),
  size: z.number()
})

export type BackupInfo = z.infer<typeof BackupInfoSchema>

export const AccountStatusSchema = z.object({
  connected: z.boolean(),
  accountId: z.string().optional(),
  accountName: z.string().optional()
})

export type AccountStatus = z.infer<typeof AccountStatusSchema>

export const AccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional()
})

export type Account = z.infer<typeof AccountSchema>

export const ZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string()
})

export type Zone = z.infer<typeof ZoneSchema>

export const RemoteHostnameSchema = z.object({
  hostname: z.string(),
  service: z.string(),
  path: z.string().optional(),
  noTlsVerify: z.boolean().optional()
})

export type RemoteHostname = z.infer<typeof RemoteHostnameSchema>

export const CloudflaredServiceSchema = z.object({
  serviceName: z.string(),
  displayName: z.string(),
  state: z.enum(['running', 'stopped', 'starting', 'unknown']),
  kind: z.enum(['remote', 'local', 'unlinked']),
  cfTunnelId: z.string().optional(),
  metricsPort: z.number().optional(),
  logPath: z.string().optional(),
  binaryVersion: z.string().optional()
})

export type CloudflaredService = z.infer<typeof CloudflaredServiceSchema>

export const BinaryReleaseSchema = z.object({
  version: z.string(),
  releaseUrl: z.string(),
  publishedAt: z.string().optional(),
  downloadUrl: z.string(),
  sha256: z.string().optional(),
  hasChecksum: z.boolean(),
  isUpdateAvailable: z.boolean()
})

export type BinaryRelease = z.infer<typeof BinaryReleaseSchema>

export const DownloadProgressPayloadSchema = z.object({
  percent: z.number(),
  transferred: z.number(),
  total: z.number()
})

export type DownloadProgressPayload = z.infer<typeof DownloadProgressPayloadSchema>
