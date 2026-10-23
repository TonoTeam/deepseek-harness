import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The child owns `--expose-gc` and runs the real facility from source through
// the repository tsx launch path; only its backend and raw snapshot are
// synthetic.
const PROBE = fileURLToPath(new URL('./fixtures/bootstrap-retention-probe.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const TSCONFIG = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const CHILD_TIMEOUT_MS = 30_000

interface ProbeResult {
  readonly collected: boolean
  readonly retained: readonly string[]
  readonly open: boolean
}

interface ProbeExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
}

/** Run the probe to exit, distinguishing a timeout or signal from a nonzero exit. */
async function runProbe(): Promise<ProbeExit> {
  const child = spawn(
    process.execPath,
    ['--expose-gc', '--import', import.meta.resolve('tsx/esm'), PROBE],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, CHILD_TIMEOUT_MS)
  try {
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, exitSignal) => { resolve([exitCode, exitSignal]) })
    })
    return { code, signal, timedOut, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

describe('open-time bootstrap retention', () => {
  it('collects the raw loadAll snapshot while the opened domain stays live', async () => {
    const exit = await runProbe()
    const diagnostic = `probe stdout: ${JSON.stringify(exit.stdout)}\nprobe stderr: ${JSON.stringify(exit.stderr)}`
    if (exit.timedOut) {
      throw new Error(`bootstrap retention probe timed out after ${CHILD_TIMEOUT_MS} ms\n${diagnostic}`)
    }
    if (exit.signal !== null) {
      throw new Error(`bootstrap retention probe was killed by ${exit.signal}\n${diagnostic}`)
    }
    expect(exit.code, diagnostic).toBe(0)
    const result = JSON.parse(exit.stdout.trim()) as ProbeResult
    expect(result, diagnostic).toMatchObject({ collected: true, retained: [], open: true })
  }, 60_000)
})
