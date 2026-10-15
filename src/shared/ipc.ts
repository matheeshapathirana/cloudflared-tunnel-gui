import { z } from 'zod'
import {
  TunnelSchema,
  TunnelStatusSchema,
  BinaryStatusSchema,
  SettingsViewSchema,
  SettingsPatchSchema,
  IngressRuleSchema,
  BackupInfoSchema,
  AccountStatusSchema,
  AccountSchema,
  ZoneSchema,
  RemoteHostnameSchema,
  CloudflaredServiceSchema,
  BinaryReleaseSchema,
  DownloadProgressPayloadSchema
} from './schemas'

const cmd = <I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O
): { input: I; output: O } => ({ input, output })

export const commands = {
  'tunnels.list': cmd(z.void(), z.array(TunnelSchema)),
  'tunnels.start': cmd(z.object({ id: z.string().uuid() }), z.void()),
  'tunnels.stop': cmd(z.object({ id: z.string().uuid() }), z.void()),
  'tunnels.logs': cmd(
    z.object({ id: z.string().uuid(), limit: z.number().int().positive().optional() }),
    z.array(z.string())
  ),
  'tunnels.rename': cmd(
    z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80) }),
    TunnelSchema
  ),
  'tunnels.setAutoStart': cmd(
    z.object({ id: z.string().uuid(), autoStart: z.boolean() }),
    TunnelSchema
  ),
  'tunnels.delete': cmd(z.object({ id: z.string().uuid() }), z.void()),
  'quick.start': cmd(z.object({ target: z.string().trim().min(1) }), TunnelSchema),
  'quick.stop': cmd(z.object({ id: z.string().uuid() }), z.void()),
  'quick.recentTargets': cmd(z.void(), z.array(z.string())),
  'quick.clearRecentTargets': cmd(z.void(), z.void()),
  'local.import': cmd(z.void(), z.array(TunnelSchema)),
  'local.readConfig': cmd(
    z.object({ configPath: z.string().min(1) }),
    z.object({ rawYaml: z.string(), ingress: z.array(IngressRuleSchema) })
  ),
  'local.saveConfig': cmd(
    z.object({ configPath: z.string().min(1), rawYaml: z.string().min(1) }),
    z.void()
  ),
  'local.validate': cmd(
    z.object({ rawYaml: z.string().min(1) }),
    z.object({ valid: z.boolean(), error: z.string().optional() })
  ),
  'local.listBackups': cmd(z.object({ configPath: z.string().min(1) }), z.array(BackupInfoSchema)),
  'local.restoreBackup': cmd(
    z.object({ configPath: z.string().min(1), backupPath: z.string().min(1) }),
    z.void()
  ),
  'local.checkCert': cmd(
    z.void(),
    z.object({ hasCert: z.boolean(), certPath: z.string().optional() })
  ),
  'local.login': cmd(z.void(), z.void()),
  'local.create': cmd(z.object({ name: z.string().trim().min(1).max(80) }), TunnelSchema),
  'account.status': cmd(z.void(), AccountStatusSchema),
  'account.setToken': cmd(
    z.object({ token: z.string().min(1), accountId: z.string().optional() }),
    z.object({
      status: AccountStatusSchema,
      accounts: z.array(AccountSchema),
      zones: z.array(ZoneSchema)
    })
  ),
  'account.clearToken': cmd(z.void(), z.void()),
  'account.listZones': cmd(z.void(), z.array(ZoneSchema)),
  'account.tokenCreationUrl': cmd(z.void(), z.object({ url: z.string() })),
  'remote.create': cmd(z.object({ name: z.string().min(1) }), TunnelSchema),
  'remote.listHostnames': cmd(z.object({ tunnelId: z.string() }), z.array(RemoteHostnameSchema)),
  'remote.addHostname': cmd(
    z.object({
      tunnelId: z.string(),
      zoneId: z.string(),
      hostname: z.string().min(1),
      service: z.string().min(1),
      noTlsVerify: z.boolean().optional()
    }),
    z.void()
  ),
  'remote.removeHostname': cmd(
    z.object({
      tunnelId: z.string(),
      zoneId: z.string().optional(),
      hostname: z.string().min(1)
    }),
    z.void()
  ),
  'remote.delete': cmd(z.object({ tunnelId: z.string() }), z.void()),
  'services.list': cmd(z.void(), z.array(CloudflaredServiceSchema)),
  'services.start': cmd(z.object({ serviceName: z.string().min(1) }), z.void()),
  'services.stop': cmd(z.object({ serviceName: z.string().min(1) }), z.void()),
  'services.restart': cmd(z.object({ serviceName: z.string().min(1) }), z.void()),
  'services.install': cmd(z.object({ tunnelId: z.string().uuid() }), TunnelSchema),
  'services.uninstall': cmd(z.object({ tunnelId: z.string().uuid() }), TunnelSchema),
  'services.adopt': cmd(z.object({ serviceName: z.string().min(1) }), CloudflaredServiceSchema),
  'tunnels.refresh': cmd(z.void(), z.array(TunnelSchema)),
  'binary.status': cmd(z.void(), BinaryStatusSchema),
  'binary.setOverride': cmd(
    z.object({ path: z.string().trim().min(1).nullable() }),
    BinaryStatusSchema
  ),
  'binary.checkUpdate': cmd(z.void(), BinaryReleaseSchema),
  'binary.download': cmd(
    z.object({ confirmWithoutChecksum: z.boolean().optional() }),
    BinaryStatusSchema
  ),
  'app.getSettings': cmd(z.void(), SettingsViewSchema),
  'app.setSettings': cmd(SettingsPatchSchema, SettingsViewSchema),
  'app.quit': cmd(z.void(), z.void())
} as const

export type CommandName = keyof typeof commands
export type CommandInput<K extends CommandName> = z.input<(typeof commands)[K]['input']>
export type CommandOutput<K extends CommandName> = z.output<(typeof commands)[K]['output']>

export const events = {
  'registry:changed': z.array(TunnelSchema),
  'tunnel:status': z.object({ id: z.string(), status: TunnelStatusSchema }),
  'tunnel:log': z.object({ id: z.string(), line: z.string() }),
  'binary:downloadProgress': DownloadProgressPayloadSchema
} as const

export type EventName = keyof typeof events
export type EventPayload<K extends EventName> = z.output<(typeof events)[K]>

export const INVOKE_CHANNEL = 'ipc:invoke'
export const EVENT_CHANNEL = 'ipc:event'
