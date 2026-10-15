import type { UpdateState } from '@shared/schemas'

function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

export function describeUpdate(state: UpdateState): string {
  const { status } = state
  switch (status.state) {
    case 'idle':
      return status.checkedAt === undefined
        ? 'Up to date'
        : `Up to date · checked ${formatClock(status.checkedAt)}`
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Update ${status.version} found`
    case 'downloading':
      return `Downloading ${status.version} (${status.percent}%)`
    case 'ready':
      return `${status.version} is ready to install`
    case 'error':
      return `Couldn't check for updates: ${status.message}`
  }
}
