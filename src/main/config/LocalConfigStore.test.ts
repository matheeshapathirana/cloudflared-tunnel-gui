import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalConfigStore } from './LocalConfigStore'
import type { BinaryStatus } from '../../shared/schemas'

describe('LocalConfigStore', () => {
  let tmpDir: string
  let store: LocalConfigStore
  let mockBinary: { status: () => Promise<BinaryStatus> }

  const sampleValidYaml = `tunnel: 123e4567-e89b-12d3-a456-426614174000
credentials-file: /path/to/123e4567-e89b-12d3-a456-426614174000.json

ingress:
  - hostname: app.example.com
    service: http://localhost:3000
  # catch-all rule
  - service: http_status:404
`

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-config-test-'))
    mockBinary = {
      status: vi.fn(async () => ({
        found: false as const,
        searched: [],
        overrideInvalid: false
      }))
    }

    store = new LocalConfigStore({
      binaryManager: mockBinary,
      defaultConfigDir: tmpDir
    })
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  it('scans config directory and discovers valid local tunnels', async () => {
    const validConfig = path.join(tmpDir, 'my-app.yml')
    await fs.promises.writeFile(validConfig, sampleValidYaml, 'utf8')

    const invalidConfig = path.join(tmpDir, 'invalid.yml')
    await fs.promises.writeFile(invalidConfig, 'hello: world\n', 'utf8')

    const tunnels = await store.scanConfigs()
    expect(tunnels.length).toBe(1)
    expect(tunnels[0].name).toBe('my-app')
    expect(tunnels[0].kind).toBe('local')
    expect(tunnels[0].cfTunnelId).toBe('123e4567-e89b-12d3-a456-426614174000')
    expect(tunnels[0].local?.configPath).toBe(validConfig)
  })

  it('reads config file and parses ingress rules', async () => {
    const configFile = path.join(tmpDir, 'test.yml')
    await fs.promises.writeFile(configFile, sampleValidYaml, 'utf8')

    const res = await store.readConfig(configFile)
    expect(res.rawYaml).toBe(sampleValidYaml)
    expect(res.ingress.length).toBe(2)
    expect(res.ingress[0].hostname).toBe('app.example.com')
    expect(res.ingress[0].service).toBe('http://localhost:3000')
    expect(res.ingress[1].service).toBe('http_status:404')
  })

  it('validates YAML structure and catch-all rules', async () => {
    const validRes = await store.validateYaml(sampleValidYaml)
    expect(validRes.valid).toBe(true)

    // Missing tunnel
    const missingTunnel = await store.validateYaml('ingress:\n  - service: http_status:404\n')
    expect(missingTunnel.valid).toBe(false)
    expect(missingTunnel.error).toContain('tunnel')

    // Missing ingress
    const missingIngress = await store.validateYaml(
      'tunnel: 123e4567-e89b-12d3-a456-426614174000\n'
    )
    expect(missingIngress.valid).toBe(false)
    expect(missingIngress.error).toContain('ingress')

    // Last rule is not a catch-all
    const invalidCatchAll = `tunnel: 123e4567-e89b-12d3-a456-426614174000
ingress:
  - hostname: app.example.com
    service: http://localhost:3000
`
    const catchAllRes = await store.validateYaml(invalidCatchAll)
    expect(catchAllRes.valid).toBe(false)
    expect(catchAllRes.error).toContain('catch-all')
  })

  it('creates, lists, and rotates backups keeping max 5', async () => {
    const configFile = path.join(tmpDir, 'backup-test.yml')
    await fs.promises.writeFile(configFile, sampleValidYaml, 'utf8')

    // Create 7 backups with small delay to ensure distinct mtimes
    for (let i = 0; i < 7; i++) {
      await store.createBackup(configFile)
      await new Promise((r) => setTimeout(r, 10))
    }

    const backups = await store.listBackups(configFile)
    expect(backups.length).toBe(5)
    expect(backups[0].timestamp).toBeGreaterThanOrEqual(backups[1].timestamp)
  })

  it('restores backup successfully', async () => {
    const configFile = path.join(tmpDir, 'restore-test.yml')
    await fs.promises.writeFile(configFile, sampleValidYaml, 'utf8')

    const backupFile = await store.createBackup(configFile)
    expect(backupFile).not.toBeNull()

    // Overwrite config
    await fs.promises.writeFile(configFile, 'corrupted content', 'utf8')

    // Restore
    await store.restoreBackup(configFile, backupFile!)
    const restored = await fs.promises.readFile(configFile, 'utf8')
    expect(restored).toBe(sampleValidYaml)
  })

  it('refuses to restore anything that is not a backup of that config', async () => {
    const configFile = path.join(tmpDir, 'guard-test.yml')
    const otherConfig = path.join(tmpDir, 'other.yml')
    await fs.promises.writeFile(configFile, sampleValidYaml, 'utf8')
    await fs.promises.writeFile(otherConfig, 'secret: other\n', 'utf8')
    const ownBackup = (await store.createBackup(configFile))!
    const otherBackup = (await store.createBackup(otherConfig))!

    // an arbitrary file, a file next to the config, and another config's backup
    const stray = path.join(tmpDir, 'stray.txt')
    await fs.promises.writeFile(stray, 'not yaml: [', 'utf8')
    const lookalike = path.join(tmpDir, 'backups', 'guard-test.yml.bak-notdigits.yml')
    await fs.promises.writeFile(lookalike, 'x: y\n', 'utf8')

    for (const bad of [
      stray,
      otherConfig,
      otherBackup,
      lookalike,
      path.join(tmpDir, '..', 'x.yml')
    ]) {
      await expect(store.restoreBackup(configFile, bad)).rejects.toMatchObject({
        code: 'VALIDATION'
      })
    }
    expect(await fs.promises.readFile(configFile, 'utf8')).toBe(sampleValidYaml)

    await expect(store.restoreBackup(configFile, ownBackup)).resolves.toBeUndefined()
  })

  describe('deleting a local tunnel', () => {
    const tunnelId = '123e4567-e89b-12d3-a456-426614174000'
    const otherId = '223e4567-e89b-12d3-a456-426614174111'

    it('removes only this tunnel config, its backups and its credentials', async () => {
      const config = path.join(tmpDir, 'mine.yml')
      const otherConfig = path.join(tmpDir, 'other.yml')
      await fs.promises.writeFile(config, sampleValidYaml, 'utf8')
      await fs.promises.writeFile(otherConfig, sampleValidYaml, 'utf8')
      await fs.promises.writeFile(path.join(tmpDir, `${tunnelId}.json`), '{}', 'utf8')
      await fs.promises.writeFile(path.join(tmpDir, `${otherId}.json`), '{}', 'utf8')
      await fs.promises.writeFile(path.join(tmpDir, 'cert.pem'), 'cert', 'utf8')
      const myBackup = (await store.createBackup(config))!
      const otherBackup = (await store.createBackup(otherConfig))!

      const removed = await store.deleteLocalFiles({
        cfTunnelId: tunnelId,
        local: { configPath: config }
      })

      expect(removed.sort()).toEqual(
        [config, myBackup, path.join(tmpDir, `${tunnelId}.json`)].map((p) => path.resolve(p)).sort()
      )
      // everything that is not this tunnel's stays
      for (const keep of [
        otherConfig,
        otherBackup,
        path.join(tmpDir, `${otherId}.json`),
        path.join(tmpDir, 'cert.pem')
      ]) {
        expect(fs.existsSync(keep), keep).toBe(true)
      }
    })

    it('does not fail when the files are already gone', async () => {
      const removed = await store.deleteLocalFiles({
        cfTunnelId: tunnelId,
        local: { configPath: path.join(tmpDir, 'missing.yml') }
      })
      expect(removed).toEqual([])
    })

    it('never deletes outside the cloudflared directory or non-YAML files', async () => {
      const outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'outside-'))
      try {
        const outside = path.join(outsideDir, 'precious.yml')
        const cert = path.join(tmpDir, 'cert.pem')
        await fs.promises.writeFile(outside, 'keep: me\n', 'utf8')
        await fs.promises.writeFile(cert, 'cert', 'utf8')

        for (const configPath of [outside, cert, path.join(tmpDir, '..', 'x.yml')]) {
          await store.deleteLocalFiles({ local: { configPath } })
        }
        // a malformed tunnel id must not be turned into a path either
        await store.deleteLocalFiles({ cfTunnelId: '..\\..\\cert', local: undefined })

        expect(fs.existsSync(outside)).toBe(true)
        expect(fs.existsSync(cert)).toBe(true)
      } finally {
        await fs.promises.rm(outsideDir, { recursive: true, force: true })
      }
    })

    it('deletes the Cloudflare tunnel with the cloudflared CLI, only with a valid id and a cert', async () => {
      const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }))
      const cliStore = new LocalConfigStore({
        binaryManager: {
          status: async () => ({
            found: true as const,
            path: 'C:\\bin\\cloudflared.exe',
            source: 'path' as const,
            version: '2026.10.0',
            overrideInvalid: false
          })
        },
        defaultConfigDir: tmpDir,
        execFile
      })

      await expect(cliStore.deleteTunnelViaCli(tunnelId)).rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringContaining('cert.pem')
      })
      await fs.promises.writeFile(path.join(tmpDir, 'cert.pem'), 'cert', 'utf8')
      await expect(cliStore.deleteTunnelViaCli('--force; calc')).rejects.toMatchObject({
        code: 'VALIDATION'
      })
      expect(execFile).not.toHaveBeenCalled()

      await cliStore.deleteTunnelViaCli(tunnelId)
      expect(execFile).toHaveBeenCalledWith('C:\\bin\\cloudflared.exe', [
        'tunnel',
        'delete',
        tunnelId
      ])
    })
  })

  it('saves valid configuration and creates backup', async () => {
    const configFile = path.join(tmpDir, 'save-test.yml')
    await fs.promises.writeFile(configFile, sampleValidYaml, 'utf8')

    const updatedYaml = sampleValidYaml.replace('localhost:3000', 'localhost:8080')
    await store.saveConfig(configFile, updatedYaml)

    const saved = await fs.promises.readFile(configFile, 'utf8')
    expect(saved).toBe(updatedYaml)

    const backups = await store.listBackups(configFile)
    expect(backups.length).toBe(1)
  })

  it('checks for cert.pem in configDir', async () => {
    const initial = await store.checkCert()
    expect(initial.hasCert).toBe(false)

    await fs.promises.writeFile(path.join(tmpDir, 'cert.pem'), 'fake cert', 'utf8')
    const after = await store.checkCert()
    expect(after.hasCert).toBe(true)
  })
})
