#!/usr/bin/env node
/**
 * comfy-image — render one image from a text prompt with the local ComfyUI, built to be driven by
 * other AI agents: logs go to stderr, the result is a single JSON line on stdout, and the exit
 * code says what went wrong. ComfyUI is launched on demand; see comfy-common.mjs.
 *
 * The workflow is comfy-zimage.json beside this script: __PROMPT__ is replaced with the prompt,
 * and the latent size / seed / steps / negative prompt are overridden when asked. With
 * --transparent the image goes through the workflow's BiRefNet background removal and is saved
 * as an RGBA PNG; otherwise that branch is dropped.
 *
 * A 1920x1080 render normally finishes in under 60s; the render timeout scales from that with the
 * pixel count, and is doubled for the first render after a launch (models load then).
 *
 * Usage: node comfy-image.mjs --prompt "a red fox in snow" --out D:/tmp/fox.png [options]
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
  applyOverrides,
  applyTokens,
  configureLog,
  connect,
  finish,
  intOption,
  log,
  readPrompt,
  render,
  renderTimeout,
  runCli,
  setTransparency,
  timestampedPng,
} from './comfy-common.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const DEFAULT_WORKFLOW = join(here, 'comfy-zimage.json')
const DEFAULT_OUTPUT_DIR = join(here, 'output')
const PROMPT_TOKEN = '__PROMPT__'
/** A 1920x1080 render normally finishes within this; bigger images get proportionally longer. */
const RENDER_SECONDS_PER_FHD = 60
/** Prompts shorter than this many words rarely make a good image; see README.md. */
const SHORT_PROMPT_WORDS = 50

const HELP = `comfy-image — generate one image from a prompt with the local ComfyUI (Z-Image Turbo).

Usage:
  node comfy-image.mjs --prompt "<text>" [--out <file.png>] [options]
  echo "<text>" | node comfy-image.mjs --prompt - --out <file.png>
  node comfy-image.mjs --check     # is ComfyUI up? never launches
  node comfy-image.mjs --start     # make sure ComfyUI is up, then exit

Options:
  --prompt <text>     The image prompt. "-" reads it from stdin. Under ${SHORT_PROMPT_WORDS} words logs a
                      warning and adds a "warning" field to the output. See "Prompting" below.
  --prompt-file <p>   Read the prompt from a UTF-8 text file.
  --out <path>        Where to write the PNG. Default output/comfy-image-<timestamp>.png
                      next to this script.
  --transparent       Remove the background (BiRefNet) and write an RGBA PNG with a transparent
                      background. Works best when the prompt puts one subject on a plain,
                      contrasting background.
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

Prompting (full guide and examples in README.md):
  Cover four elements, most important first (earlier words carry more weight):
    1. Subject      who/what, pose, clothing, expression, materials.
    2. Style        one medium: photography, oil painting, 3D render, anime, ink painting...
    3. Lighting     golden hour, neon glow, soft window light, dramatic shadows; mood, palette.
    4. Composition  close-up, wide-angle, shallow depth of field, centred. Use quality words
                    like "high detail" sparingly, two or three at most.
  Text in the image: wrap it in straight quotes ("MORNING BLEND"), name the lettering (serif,
  handwritten, neon, calligraphy), and keep it to one word or a short phrase.
  Pitfalls: don't write negatives ("no people" can add people), describe the empty scene
  instead or use --negative; don't mix styles ("realistic anime watercolor 3D render").

Output (stdout, one JSON line):
  success: {"ok":true,"path":"<absolute png path>","width":1024,"height":1024,"seed":123,
            "transparent":false,"prompt":"...","promptId":"...","seconds":12.3,"launched":false,
            "attempts":1}
  failure: {"ok":false,"error":"<message>","code":<exit code>}

Exit codes: 0 ok, 1 render failed, 2 bad arguments, 3 ComfyUI unreachable.
Renders are serialised by ComfyUI's own queue, so parallel calls are safe but wait their turn.`

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
        transparent: { type: 'boolean', default: false },
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
  configureLog('comfy-image', values.quiet)
  const session = await connect(values)

  // Validate everything before possibly spending minutes launching ComfyUI.
  const prompt = await readPrompt(values)
  const words = prompt.split(/\s+/).filter(Boolean).length
  const warning =
    words < SHORT_PROMPT_WORDS
      ? `prompt is only ${words} words; cover subject, style, lighting and composition, most important first — see README.md`
      : undefined
  if (warning) log(`warning: ${warning}`)
  const width = intOption('--width', values.width, 64)
  const height = intOption('--height', values.height, 64)
  const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 32) : intOption('--seed', values.seed, 0)
  const steps = values.steps === undefined ? null : intOption('--steps', values.steps, 1)
  const timeoutFor = renderTimeout(values.timeout, RENDER_SECONDS_PER_FHD, width * height)

  const workflowPath = values.workflow ? resolve(values.workflow) : DEFAULT_WORKFLOW
  if (!existsSync(workflowPath)) throw new CliError(`workflow not found: ${workflowPath}`, EXIT.usage)
  const outPath = values.out ? resolve(values.out) : timestampedPng(DEFAULT_OUTPUT_DIR, 'comfy-image')

  const transparent = values.transparent
  const workflow = setTransparency(
    applyOverrides(applyTokens(JSON.parse(readFileSync(workflowPath, 'utf8')), { [PROMPT_TOKEN]: prompt }), {
      width,
      height,
      seed,
      steps,
      negative: values.negative ?? null,
    }),
    transparent,
  )

  const result = await render(session, {
    prepare: async () => workflow,
    timeoutFor,
    describe: `${width}x${height}, seed ${seed}${transparent ? ', transparent' : ''}`,
    outPath,
  })
  finish({ ok: true, path: result.path, width, height, seed, transparent, prompt, ...result, ...(warning && { warning }) }, EXIT.ok)
}

runCli(main)
