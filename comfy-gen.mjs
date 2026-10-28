#!/usr/bin/env node
/**
 * comfy-gen — render one image from a text prompt with the local ComfyUI, built to be driven by
 * other AI agents: logs go to stderr, the result is a single JSON line on stdout, and the exit
 * code says what went wrong. ComfyUI is launched on demand; see comfy-common.mjs.
 *
 * The workflow is comfy-zimage.json beside this script: __PROMPT__ is replaced with the prompt,
 * and the latent size / seed / steps / negative prompt are overridden when asked.
 *
 * A 1920x1080 render normally finishes in under 60s; the render timeout scales from that with the
 * pixel count, and is doubled for the first render after a launch (models load then).
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
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  COMMON_OPTIONS,
  COMMON_OPTIONS_HELP,
  CliError,
  EXIT,
  configureLog,
  connect,
  finish,
  intOption,
  readPrompt,
  render,
  renderTimeout,
  runCli,
  timestampedPng,
} from './comfy-common.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const DEFAULT_WORKFLOW = join(here, 'comfy-zimage.json')
const DEFAULT_OUTPUT_DIR = join(here, 'output')
const PROMPT_TOKEN = '__PROMPT__'
/** A 1920x1080 render normally finishes within this; bigger images get proportionally longer. */
const RENDER_SECONDS_PER_FHD = 60

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
  --width <px>        Image width.  Default 1024. Multiples of 16 work best.
  --height <px>       Image height. Default 1024.
  --seed <n>          Fixed seed for a reproducible image. Default random.
  --steps <n>         Sampler steps. Default 10 (from the workflow).
  --negative <text>   Override the negative prompt.
  --workflow <p>      API-format workflow JSON with a ${PROMPT_TOKEN} token.
                      Default comfy-zimage.json next to this script.
  --timeout <s>       Render budget per attempt. Default scales with size: 60s per 1920x1080
                      worth of pixels (at least 60s), doubled right after a launch.
${COMMON_OPTIONS_HELP}

Output (stdout, one JSON line):
  success: {"ok":true,"path":"<absolute png path>","width":1024,"height":1024,"seed":123,
            "prompt":"...","promptId":"...","seconds":12.3,"launched":false,"attempts":1}
  failure: {"ok":false,"error":"<message>","code":<exit code>}

Exit codes: 0 ok, 1 render failed, 2 bad arguments, 3 ComfyUI unreachable.
Renders are serialised by ComfyUI's own queue, so parallel calls are safe but wait their turn.`

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

// --- main ---------------------------------------------------------------------

function parseCli() {
  try {
    return parseArgs({
      allowPositionals: false,
      options: {
        ...COMMON_OPTIONS,
        prompt: { type: 'string' },
        'prompt-file': { type: 'string' },
        out: { type: 'string' },
        width: { type: 'string', default: '1024' },
        height: { type: 'string', default: '1024' },
        seed: { type: 'string' },
        steps: { type: 'string' },
        negative: { type: 'string' },
        workflow: { type: 'string' },
      },
    }).values
  } catch (error) {
    throw new CliError(`${error.message} (see --help)`, EXIT.usage)
  }
}

async function main() {
  const values = parseCli()
  if (values.help) {
    process.stdout.write(`${HELP}\n`)
    process.exit(EXIT.ok)
  }
  configureLog('comfy-gen', values.quiet)
  const session = await connect(values)

  // Validate everything before possibly spending minutes launching ComfyUI.
  const prompt = await readPrompt(values)
  const width = intOption('--width', values.width, 64)
  const height = intOption('--height', values.height, 64)
  const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 32) : intOption('--seed', values.seed, 0)
  const steps = values.steps === undefined ? null : intOption('--steps', values.steps, 1)
  const timeoutFor = renderTimeout(values.timeout, RENDER_SECONDS_PER_FHD, width * height)

  const workflowPath = values.workflow ? resolve(values.workflow) : DEFAULT_WORKFLOW
  if (!existsSync(workflowPath)) throw new CliError(`workflow not found: ${workflowPath}`, EXIT.usage)
  const outPath = values.out ? resolve(values.out) : timestampedPng(DEFAULT_OUTPUT_DIR, 'comfy')

  const workflow = applyOverrides(applyTokens(JSON.parse(readFileSync(workflowPath, 'utf8')), { [PROMPT_TOKEN]: prompt }), {
    width,
    height,
    seed,
    steps,
    negative: values.negative ?? null,
  })

  const result = await render(session, {
    prepare: async () => workflow,
    timeoutFor,
    describe: `${width}x${height}, seed ${seed}`,
    outPath,
  })
  finish({ ok: true, path: result.path, width, height, seed, prompt, ...result }, EXIT.ok)
}

runCli(main)
