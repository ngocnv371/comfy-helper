#!/usr/bin/env node
/**
 * comfy-gen — render one image from a text prompt with the local ComfyUI, built to be driven by
 * other AI agents: logs go to stderr, the result is a single JSON line on stdout, and the exit
 * code says what went wrong.
 *
 * If ComfyUI is not answering on the default port it is launched through comfyui-user.bat
 * (outside this process tree, so it outlives this process) and waited on; a launch that does not
 * answer within --launch-timeout (30s) is killed and relaunched. No launch is attempted while less
 * than half the system RAM is free — ComfyUI would only die out of memory. Concurrent callers
 * share one launch through a lock file, so two agents never start two servers. ComfyUI sometimes
 * crashes under memory pressure; a render that dies with it is relaunched and retried (--retries).
 *
 * A 1920x1080 render normally finishes in under 60s; the render timeout scales from that with the
 * pixel count, and is doubled for the first render after a launch (models load then).
 *
 * The workflow is comfy-zimage.json beside this script: __PROMPT__ is replaced with the prompt,
 * and the latent size / seed / steps / negative prompt are overridden when asked.
 *
 * Usage: node comfy-gen.mjs --prompt "a red fox in snow" --out D:/tmp/fox.png [options]
 * Run with --help for every option.
 *
 * Exit codes:
 *   0  success (or --check found ComfyUI running)
 *   1  render failed (workflow rejected, timed out, no image)
 *   2  bad arguments
 *   3  ComfyUI not reachable / failed to start
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { freemem, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))

const DEFAULT_WORKFLOW = join(here, 'comfy-zimage.json')
const DEFAULT_OUTPUT_DIR = join(here, 'output')
const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188'
const LAUNCH_SCRIPT = 'D:\\dev\\comfyui-rocm\\comfyui-user.bat'
const LAUNCH_LOCK = join(tmpdir(), 'comfy-helper-launch.lock')
const PROMPT_TOKEN = '__PROMPT__'
const CLIENT_ID = 'comfy-gen'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Below this share of free system RAM a fresh ComfyUI dies out of memory while loading. */
const MIN_FREE_RAM = 0.5
/** A 1920x1080 render normally finishes within this; bigger images get proportionally longer. */
const RENDER_SECONDS_PER_FHD = 60
const FHD_PIXELS = 1920 * 1080

const EXIT = { ok: 0, failed: 1, usage: 2, unavailable: 3 }

const HELP = `comfy-gen — generate one image from a prompt with the local ComfyUI (Z-Image Turbo).

Usage:
  node comfy-gen.mjs --prompt "<text>" [--out <file.png>] [options]
  echo "<text>" | node comfy-gen.mjs --prompt - --out <file.png>
  node comfy-gen.mjs --check     # is ComfyUI up? never launches
  node comfy-gen.mjs --start     # make sure ComfyUI is up, then exit

Options:
  --prompt <text>     The image prompt. "-" reads it from stdin.
  --prompt-file <p>   Read the prompt from a UTF-8 text file.
  --out <path>        Where to write the PNG. Default output/comfy-<timestamp>.png
                      next to this script.
                      Parent folders are created.
  --width <px>        Image width.  Default 1024. Multiples of 16 work best.
  --height <px>       Image height. Default 1024.
  --seed <n>          Fixed seed for a reproducible image. Default random.
  --steps <n>         Sampler steps. Default 10 (from the workflow).
  --negative <text>   Override the negative prompt.
  --workflow <p>      API-format workflow JSON with a ${PROMPT_TOKEN} token.
                      Default comfy-zimage.json next to this script.
  --url <url>         ComfyUI base URL. Default env COMFY_URL, then ${DEFAULT_COMFY_URL}.
  --no-launch         Fail (exit 3) instead of launching ComfyUI when it is down.
  --launch-timeout <s>  How long a launch may go unanswered before it is killed. Default 30.
  --launch-attempts <n> Kill-and-relaunch attempts before giving up (exit 3). Default 3.
                      No launch happens while less than 50% of system RAM is free (exit 3):
                      ComfyUI would die out of memory.
  --timeout <s>       Render budget per attempt. Default scales with size: 60s per 1920x1080
                      worth of pixels (at least 60s), doubled right after a launch.
  --retries <n>       If ComfyUI crashes mid-render (it does, out of memory) it is relaunched
                      and the render retried; an OOM error frees VRAM and retries. Default 2.
  --quiet             No progress logs on stderr.
  --help              Show this message.

Output (stdout, one JSON line):
  success: {"ok":true,"path":"<absolute png path>","width":1024,"height":1024,"seed":123,
            "prompt":"...","promptId":"...","seconds":12.3,"launched":false,"attempts":1}
  failure: {"ok":false,"error":"<message>","code":<exit code>}

Exit codes: 0 ok, 1 render failed, 2 bad arguments, 3 ComfyUI unreachable.
Renders are serialised by ComfyUI's own queue, so parallel calls are safe but wait their turn.`

// --- io -----------------------------------------------------------------------

let quiet = false
const log = (message) => {
  if (!quiet) process.stderr.write(`[comfy-gen] ${message}\n`)
}

function finish(result, code) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(code)
}

class CliError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/** A failure worth another attempt: ComfyUI crashed (often out of VRAM) or ran out of memory. */
class RetryableError extends CliError {
  constructor(message, { crashed }) {
    super(message, EXIT.failed)
    this.crashed = crashed
  }
}

const OOM_PATTERN = /out of memory|OutOfMemory|HIP error|CUDA error|allocat/i

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// --- workflow -----------------------------------------------------------------

/**
 * Substitutes tokens inside the serialised workflow. The value is JSON-escaped and its quotes
 * stripped before splicing, so prompts with quotes, backslashes or newlines stay valid JSON.
 */
function applyTokens(workflow, replacements) {
  let text = JSON.stringify(workflow)
  for (const [token, value] of Object.entries(replacements)) {
    if (!text.includes(token)) throw new CliError(`token ${token} not found in the workflow`, EXIT.usage)
    text = text.split(token).join(JSON.stringify(value).slice(1, -1))
  }
  return JSON.parse(text)
}

const nodesOf = (workflow) => Object.values(workflow).filter((node) => node && typeof node === 'object' && node.inputs)

function applyOverrides(workflow, { width, height, seed, steps, negative }) {
  const nodes = nodesOf(workflow)
  const latents = nodes.filter((node) => /LatentImage/.test(node.class_type ?? ''))
  if (!latents.length) throw new CliError('workflow has no latent-image node — cannot set the size', EXIT.usage)
  for (const node of latents) {
    node.inputs.width = width
    node.inputs.height = height
  }

  for (const node of nodes) {
    if (typeof node.inputs.seed === 'number') node.inputs.seed = seed
    if (steps !== null && typeof node.inputs.steps === 'number') node.inputs.steps = steps
  }

  if (negative !== null) {
    // The negative prompt is whatever text encoder feeds a sampler's `negative` input.
    for (const sampler of nodes.filter((node) => Array.isArray(node.inputs.negative))) {
      const encoder = workflow[sampler.inputs.negative[0]]
      if (encoder?.inputs && typeof encoder.inputs.text === 'string') encoder.inputs.text = negative
    }
  }
  return workflow
}

// --- ComfyUI client -----------------------------------------------------------

class ComfyClient {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/+$/, '')
  }

  async json(path, init = {}) {
    const response = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(30_000), ...init })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 600)
      throw new Error(`${path} failed: HTTP ${response.status} ${detail}`)
    }
    return response.json()
  }

  async isReachable() {
    try {
      await this.json('/system_stats', { signal: AbortSignal.timeout(3_000) })
      return true
    } catch {
      return false
    }
  }

  /** Asks ComfyUI to unload models and release VRAM; best effort. */
  async freeMemory() {
    try {
      await fetch(`${this.base}/free`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      // If it is down, the next attempt relaunches it anyway.
    }
  }

  async queuePrompt(workflow) {
    let payload
    try {
      payload = await this.json('/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID }),
      })
    } catch (error) {
      if (!(await this.isReachable())) throw new RetryableError(`ComfyUI went away while queueing: ${error.message}`, { crashed: true })
      throw new CliError(`ComfyUI rejected the workflow: ${error.message}`, EXIT.failed)
    }
    if (payload.error) {
      throw new CliError(`ComfyUI rejected the workflow: ${JSON.stringify(payload.error).slice(0, 600)}`, EXIT.failed)
    }
    if (!payload.prompt_id) throw new CliError(`ComfyUI returned no prompt_id`, EXIT.failed)
    return payload.prompt_id
  }

  async waitForOutputs(promptId, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let lastLog = Date.now()
    let downSince = null
    while (Date.now() < deadline) {
      try {
        const entry = (await this.json(`/history/${promptId}`))[promptId]
        downSince = null
        if (entry) {
          const status = entry.status ?? {}
          if (status.status_str === 'error') {
            const failure = (status.messages ?? []).find(([kind]) => kind === 'execution_error')?.[1]
            const reason = failure ? `${failure.node_type}: ${failure.exception_message}`.trim() : JSON.stringify(status)
            const message = `ComfyUI workflow failed — ${reason.slice(0, 600)}`
            if (OOM_PATTERN.test(reason)) throw new RetryableError(message, { crashed: false })
            throw new CliError(message, EXIT.failed)
          }
          if (status.completed) return entry.outputs ?? {}
        }
      } catch (error) {
        if (error instanceof CliError) throw error
        // A single dropped poll is not a failed render, but a server that stays silent has crashed
        // (usually out of memory) and the queued job died with it.
        downSince ??= Date.now()
        if (Date.now() - downSince >= 10_000 && !(await this.isReachable())) {
          throw new RetryableError(`ComfyUI stopped answering during render ${promptId} (crashed?)`, { crashed: true })
        }
        log(`poll failed (${error.message.slice(0, 80)}), retrying`)
      }
      if (Date.now() - lastLog >= 15_000) {
        lastLog = Date.now()
        log(`still rendering… ${Math.round((deadline - Date.now()) / 1000)}s left`)
      }
      await sleep(1000)
    }
    throw new CliError(`render ${promptId} did not finish within ${timeoutMs / 1000}s`, EXIT.failed)
  }

  async download({ filename, subfolder = '', type = 'output' }) {
    const params = new URLSearchParams({ filename, subfolder, type })
    const response = await fetch(`${this.base}/view?${params}`, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new CliError(`/view failed: HTTP ${response.status}`, EXIT.failed)
    return Buffer.from(await response.arrayBuffer())
  }
}

function firstImage(outputs) {
  for (const output of Object.values(outputs)) {
    if (Array.isArray(output?.images) && output.images.length) return output.images[0]
  }
  return null
}

// --- launching ----------------------------------------------------------------

/**
 * Takes the launch lock. A fresh lock means another caller is launching ComfyUI right now, so
 * this caller only waits; a lock older than one launch budget (plus slack) was abandoned.
 */
function tryTakeLaunchLock(launchTimeoutMs) {
  try {
    closeSync(openSync(LAUNCH_LOCK, 'wx'))
    return true
  } catch {
    try {
      if (Date.now() - statSync(LAUNCH_LOCK).mtimeMs > launchTimeoutMs + 10_000) {
        unlinkSync(LAUNCH_LOCK)
        closeSync(openSync(LAUNCH_LOCK, 'wx'))
        return true
      }
    } catch {
      // Lost a race with another caller — fall through and wait for its launch.
    }
    return false
  }
}

function releaseLaunchLock() {
  try {
    unlinkSync(LAUNCH_LOCK)
  } catch {
    // Already gone.
  }
}

/** Keeps a held lock fresh across relaunches so waiting callers do not take it over. */
function touchLaunchLock() {
  try {
    utimesSync(LAUNCH_LOCK, new Date(), new Date())
  } catch {
    // Gone; the next tryTakeLaunchLock recreates it.
  }
}

/**
 * Kills every ComfyUI instance started from the launch folder: the console running the launch
 * script (which lingers at its final `pause` after a crash) and the server python. Only called
 * when ComfyUI is not answering, so nothing healthy is lost.
 */
function killComfy() {
  const folder = dirname(LAUNCH_SCRIPT).replace(/'/g, "''")
  const script = LAUNCH_SCRIPT.replace(/.*\\/, '').replace(/'/g, "''")
  const command =
    `Get-CimInstance Win32_Process | Where-Object { ` +
    `($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*${script}*') -or ` +
    `($_.Name -eq 'python.exe' -and $_.CommandLine -like '*main.py*' -and $_.ExecutablePath -like '${folder}*') ` +
    `} | ForEach-Object { taskkill /T /F /PID $_.ProcessId 2>&1 | Out-Null; $_.ProcessId }`
  try {
    const killed = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    }).trim()
    if (killed) log(`killed stale ComfyUI process(es): ${killed.split(/\s+/).join(', ')}`)
  } catch (error) {
    log(`could not kill stale ComfyUI processes: ${error.message.slice(0, 120)}`)
  }
}

/**
 * Starts the launch script through WMI (Win32_Process.Create), so its parent is the WMI service:
 * ComfyUI is not a child of this process, nor of the agent that called us, and survives when
 * either exits or has its process tree killed. (Handing it to explorer.exe does the same but
 * silently stops working after a few launches.) The script needs its own folder as the working
 * directory, for .\python_env.
 */
function launchComfy() {
  const quote = (text) => text.replace(/'/g, "''")
  const command =
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ ` +
    `CommandLine = 'cmd.exe /c "${quote(LAUNCH_SCRIPT)}"'; CurrentDirectory = '${quote(dirname(LAUNCH_SCRIPT))}' }; ` +
    `if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    stdio: 'ignore',
    timeout: 30_000,
    windowsHide: true,
  })
}

/** Refuses to launch when RAM is too tight for ComfyUI to boot. */
function assertEnoughRam() {
  const free = freemem() / totalmem()
  if (free < MIN_FREE_RAM) {
    const gib = (bytes) => (bytes / 2 ** 30).toFixed(1)
    throw new CliError(
      `not launching ComfyUI: only ${gib(freemem())} of ${gib(totalmem())} GiB RAM free ` +
        `(${Math.round(free * 100)}%, need ${MIN_FREE_RAM * 100}%) — it would run out of memory`,
      EXIT.unavailable,
    )
  }
}

/** Polls until ComfyUI answers or the budget runs out. */
async function waitUntilUp(client, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    await sleep(2000)
    if (await client.isReachable()) return true
  }
  return false
}

/** Ensures ComfyUI answers, launching it if needed. Returns true when this call launched it. */
async function ensureRunning(client, { allowLaunch, launchTimeoutMs, launchAttempts, isDefaultUrl }) {
  if (await client.isReachable()) return false

  if (!allowLaunch) throw new CliError(`ComfyUI is not answering at ${client.base} (--no-launch)`, EXIT.unavailable)
  if (!isDefaultUrl) {
    throw new CliError(`ComfyUI is not answering at ${client.base}; auto-launch only applies to ${DEFAULT_COMFY_URL}`, EXIT.unavailable)
  }

  if (!existsSync(LAUNCH_SCRIPT)) {
    throw new CliError(`ComfyUI is down and the launch script is missing: ${LAUNCH_SCRIPT}`, EXIT.unavailable)
  }

  // A boot that overruns the budget is treated as hung: kill it and launch again. One caller owns
  // the launch through the lock; the others wait, and take over only if the owner disappears.
  for (let launch = 1; launch <= launchAttempts; launch += 1) {
    if (tryTakeLaunchLock(launchTimeoutMs)) {
      try {
        killComfy()
        assertEnoughRam() // after the kill, so a hung instance's memory is not counted against us
        log(`launching ${LAUNCH_SCRIPT} (attempt ${launch}/${launchAttempts}, ${launchTimeoutMs / 1000}s budget)`)
        launchComfy()
        touchLaunchLock()
        if (await waitUntilUp(client, launchTimeoutMs)) {
          log('ComfyUI is up')
          return true
        }
        log(`ComfyUI did not answer within ${launchTimeoutMs / 1000}s — terminating it`)
        killComfy()
      } finally {
        releaseLaunchLock()
      }
    } else {
      log('another caller is launching ComfyUI — waiting for it')
      if (await waitUntilUp(client, launchTimeoutMs + 10_000)) {
        log('ComfyUI is up')
        return false
      }
    }
  }
  throw new CliError(`ComfyUI did not come up at ${client.base} after ${launchAttempts} launch attempts`, EXIT.unavailable)
}

// --- main ---------------------------------------------------------------------

function parseCli() {
  try {
    return parseArgs({
      allowPositionals: false,
      options: {
        prompt: { type: 'string' },
        'prompt-file': { type: 'string' },
        out: { type: 'string' },
        width: { type: 'string', default: '1024' },
        height: { type: 'string', default: '1024' },
        seed: { type: 'string' },
        steps: { type: 'string' },
        negative: { type: 'string' },
        workflow: { type: 'string' },
        url: { type: 'string' },
        'no-launch': { type: 'boolean', default: false },
        'launch-timeout': { type: 'string', default: '30' },
        'launch-attempts': { type: 'string', default: '3' },
        retries: { type: 'string', default: '2' },
        timeout: { type: 'string' },
        check: { type: 'boolean', default: false },
        start: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    throw new CliError(`${error.message} (see --help)`, EXIT.usage)
  }
}

function intOption(flag, raw, min) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) throw new CliError(`${flag} must be an integer >= ${min}, got ${raw}`, EXIT.usage)
  return value
}

async function main() {
  const values = parseCli()
  if (values.help) {
    process.stdout.write(`${HELP}\n`)
    process.exit(EXIT.ok)
  }
  quiet = values.quiet

  const baseUrl = values.url ?? process.env.COMFY_URL ?? DEFAULT_COMFY_URL
  const client = new ComfyClient(baseUrl)
  const launchTimeoutMs = intOption('--launch-timeout', values['launch-timeout'], 1) * 1000
  const launchOptions = {
    allowLaunch: !values['no-launch'],
    launchTimeoutMs,
    launchAttempts: intOption('--launch-attempts', values['launch-attempts'], 1),
    isDefaultUrl: client.base === DEFAULT_COMFY_URL || client.base === 'http://localhost:8188',
  }

  if (values.check) {
    const running = await client.isReachable()
    finish({ ok: running, running, url: client.base }, running ? EXIT.ok : EXIT.unavailable)
  }
  if (values.start) {
    const launched = await ensureRunning(client, launchOptions)
    finish({ ok: true, running: true, launched, url: client.base }, EXIT.ok)
  }

  // Validate everything before possibly spending minutes launching ComfyUI.
  let prompt
  if (values['prompt-file']) prompt = readFileSync(resolve(values['prompt-file']), 'utf8')
  else if (values.prompt === '-') prompt = await readStdin()
  else prompt = values.prompt
  prompt = (prompt ?? '').trim()
  if (!prompt) throw new CliError('a prompt is required: --prompt "<text>", --prompt -, or --prompt-file <path>', EXIT.usage)

  const width = intOption('--width', values.width, 64)
  const height = intOption('--height', values.height, 64)
  const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 32) : intOption('--seed', values.seed, 0)
  const steps = values.steps === undefined ? null : intOption('--steps', values.steps, 1)
  const fixedTimeoutMs = values.timeout === undefined ? null : intOption('--timeout', values.timeout, 1) * 1000
  const scaledTimeoutMs = Math.ceil(RENDER_SECONDS_PER_FHD * Math.max(1, (width * height) / FHD_PIXELS)) * 1000

  const workflowPath = values.workflow ? resolve(values.workflow) : DEFAULT_WORKFLOW
  if (!existsSync(workflowPath)) throw new CliError(`workflow not found: ${workflowPath}`, EXIT.usage)
  const outPath = values.out
    ? resolve(values.out)
    : join(DEFAULT_OUTPUT_DIR, `comfy-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)

  const workflow = applyOverrides(applyTokens(JSON.parse(readFileSync(workflowPath, 'utf8')), { [PROMPT_TOKEN]: prompt }), {
    width,
    height,
    seed,
    steps,
    negative: values.negative ?? null,
  })

  const retries = intOption('--retries', values.retries, 0)
  let launched = false
  let attempts = 0
  let promptId
  let image
  const startedAt = Date.now()

  // ComfyUI can crash (or report OOM) under memory pressure; relaunch / free VRAM and retry.
  for (;;) {
    attempts += 1
    try {
      const launchedNow = await ensureRunning(client, launchOptions)
      launched ||= launchedNow
      // A freshly launched ComfyUI loads the models during its first render.
      const timeoutMs = fixedTimeoutMs ?? (launchedNow ? 2 * scaledTimeoutMs : scaledTimeoutMs)
      promptId = await client.queuePrompt(workflow)
      log(`queued ${promptId} (${width}x${height}, seed ${seed})${attempts > 1 ? ` — attempt ${attempts}` : ''}`)
      image = firstImage(await client.waitForOutputs(promptId, timeoutMs))
      break
    } catch (error) {
      if (!(error instanceof RetryableError) || attempts > retries) throw error
      log(`${error.message} — retrying (${attempts}/${retries})`)
      if (error.crashed) await sleep(5000) // let the dead process release the port and VRAM
      else await client.freeMemory()
    }
  }
  if (!image) throw new CliError('workflow finished without an image output', EXIT.failed)

  const bytes = await client.download(image)
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new CliError(`${image.filename} is not a PNG — not saved`, EXIT.failed)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, bytes)
  const seconds = Number(((Date.now() - startedAt) / 1000).toFixed(1))
  log(`saved ${outPath} in ${seconds}s`)

  finish({ ok: true, path: outPath, width, height, seed, prompt, promptId, seconds, launched, attempts }, EXIT.ok)
}

main().catch((error) => {
  const code = error instanceof CliError ? error.code : EXIT.failed
  log(`error: ${error.message}`)
  finish({ ok: false, error: error.message, code }, code)
})
