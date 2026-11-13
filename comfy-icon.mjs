#!/usr/bin/env node
/**
 * comfy-icon — render one game icon with a TRANSPARENT BACKGROUND (an RGBA PNG holding a flat white
 * pictogram; the black background is cut out to alpha) with the local ComfyUI, built to be driven by other AI agents: logs go to stderr, the result is
 * a single JSON line on stdout, and the exit code says what went wrong. ComfyUI is launched on
 * demand; see comfy-common.mjs.
 *
 * The workflow is comfy-zimage-icon.json beside this script: Z-Image Turbo, then BiRefNet
 * background removal joined back as the alpha channel. __PROMPT__ is replaced with the subject
 * description followed by the fixed icon style paragraphs (ICON_STYLE below), unless --raw.
 *
 * Usage: node comfy-icon.mjs --prompt "a single armoured gauntlet glove, upright" --out D:/tmp/gauntlet.png
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
  nodesOf,
  readPrompt,
  render,
  renderTimeout,
  runCli,
  timestampedPng,
} from './comfy-common.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const DEFAULT_WORKFLOW = join(here, 'comfy-zimage-icon.json')
const DEFAULT_OUTPUT_DIR = join(here, 'output')
const PROMPT_TOKEN = '__PROMPT__'
/** A 1920x1080 render normally finishes within this; bigger images get proportionally longer. */
const RENDER_SECONDS_PER_FHD = 60

/** Appended after the subject description: what makes every icon look like part of one set. */
const ICON_STYLE = `The icon is one solid flat white shape with a few thin black lines cut into it for its details, centred, large, filling most of the square, on a perfectly plain pure black background. Nothing else is in the picture: one object only, no people, no hands, no border, no text.

A minimalist flat vector pictogram for a game's inventory menu, like the equipment slot icons of a modern mobile RPG: bold simple silhouette, clean smooth edges, pure white on pure black, no shading, no gradients, no colour, no 3D.`

const HELP = `comfy-icon — generate one game icon WITH A TRANSPARENT BACKGROUND using the local ComfyUI
(Z-Image Turbo + BiRefNet background removal).

The output is always an RGBA PNG: a flat white pictogram whose background is fully transparent,
ready to drop onto any UI. Pass --opaque if you want the plain black background instead.

Usage:
  node comfy-icon.mjs --prompt "<subject>" [--out <file.png>] [options]
  echo "<subject>" | node comfy-icon.mjs --prompt - --out <file.png>
  node comfy-icon.mjs --check     # is ComfyUI up? never launches
  node comfy-icon.mjs --start     # make sure ComfyUI is up, then exit

Options:
  --prompt <text>     What the icon shows: one object and its shape, e.g. "A simple icon of a
                      single armoured gauntlet glove, upright, with a wide flared cuff and the
                      fingers together pointing up." The icon style (white on black, flat, one
                      object, no text) is appended for you. "-" reads it from stdin.
  --prompt-file <p>   Read the prompt from a UTF-8 text file.
  --raw               Send the prompt as-is, without the icon style paragraphs.
  --opaque            Keep the black background (skip background removal). Without it the
                      background is transparent.
  --out <path>        Where to write the transparent PNG. Default output/comfy-icon-<timestamp>.png
                      next to this script.
  --size <px>         Square size. Default 768. Multiples of 16 work best.
  --width <px>        Width, overriding --size.
  --height <px>       Height, overriding --size.
  --seed <n>          Fixed seed for a reproducible icon. Default random.
  --steps <n>         Sampler steps. Default 10 (from the workflow).
  --negative <text>   Override the negative prompt.
  --workflow <p>      API-format workflow JSON with a ${PROMPT_TOKEN} token.
                      Default comfy-zimage-icon.json next to this script.
  --timeout <s>       Render budget per attempt. Default 60s (scaled up for images bigger than
                      1920x1080), doubled right after a launch.
${COMMON_OPTIONS_HELP}

Output (stdout, one JSON line):
  success: {"ok":true,"path":"<absolute png path>","width":768,"height":768,"seed":123,
            "transparent":true,"prompt":"...","promptId":"...","seconds":12.3,"launched":false,
            "attempts":1}
  failure: {"ok":false,"error":"<message>","code":<exit code>}

Exit codes: 0 ok, 1 render failed, 2 bad arguments, 3 ComfyUI unreachable.
Renders are serialised by ComfyUI's own queue, so parallel calls are safe but wait their turn.`

// --- workflow -----------------------------------------------------------------

/**
 * Points every image output node at the decoded image itself, so the background-removal branch
 * is never asked for and the icon keeps its black background.
 */
function skipCutout(workflow) {
  const decode = Object.entries(workflow).find(([, node]) => node?.class_type === 'VAEDecode')
  if (!decode) throw new CliError('workflow has no VAEDecode node — cannot use --opaque', EXIT.usage)
  for (const node of nodesOf(workflow)) {
    if (/^(Save|Preview)Image$/.test(node.class_type ?? '')) node.inputs.images = [decode[0], 0]
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
        raw: { type: 'boolean', default: false },
        opaque: { type: 'boolean', default: false },
        out: { type: 'string' },
        size: { type: 'string', default: '768' },
        width: { type: 'string' },
        height: { type: 'string' },
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
  configureLog('comfy-icon', values.quiet)
  const session = await connect(values)

  // Validate everything before possibly spending minutes launching ComfyUI.
  const subject = await readPrompt(values)
  const prompt = values.raw ? subject : `${subject}\n\n${ICON_STYLE}`
  const size = intOption('--size', values.size, 64)
  const width = values.width === undefined ? size : intOption('--width', values.width, 64)
  const height = values.height === undefined ? size : intOption('--height', values.height, 64)
  const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 32) : intOption('--seed', values.seed, 0)
  const steps = values.steps === undefined ? null : intOption('--steps', values.steps, 1)
  const timeoutFor = renderTimeout(values.timeout, RENDER_SECONDS_PER_FHD, width * height)

  const workflowPath = values.workflow ? resolve(values.workflow) : DEFAULT_WORKFLOW
  if (!existsSync(workflowPath)) throw new CliError(`workflow not found: ${workflowPath}`, EXIT.usage)
  const outPath = values.out ? resolve(values.out) : timestampedPng(DEFAULT_OUTPUT_DIR, 'comfy-icon')

  let workflow = applyOverrides(applyTokens(JSON.parse(readFileSync(workflowPath, 'utf8')), { [PROMPT_TOKEN]: prompt }), {
    width,
    height,
    seed,
    steps,
    negative: values.negative ?? null,
  })
  if (values.opaque) workflow = skipCutout(workflow)

  const result = await render(session, {
    prepare: async () => workflow,
    timeoutFor,
    describe: `icon ${width}x${height}, seed ${seed}${values.opaque ? ', opaque' : ''}`,
    outPath,
  })
  finish({ ok: true, path: result.path, width, height, seed, transparent: !values.opaque, prompt: subject, ...result }, EXIT.ok)
}

runCli(main)
