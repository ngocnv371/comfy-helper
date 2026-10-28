#!/usr/bin/env node
/**
 * comfy-edit — render one image from a prompt plus one or more reference images with the local
 * ComfyUI (FLUX.2 Klein 4B), for agents: same io contract and auto-launch as comfy-gen.
 *
 * Each reference is uploaded into ComfyUI's input/comfy-helper folder (named by content hash, so
 * re-sending an image does not pile up copies), scaled to ~1 megapixel, VAE-encoded and chained
 * onto both the positive and negative conditioning with ReferenceLatent — the recipe from
 * ComfyUI's "Image Edit (Flux.2 Klein 4B)" template. Without --width/--height the output takes the
 * first reference's (scaled) size, which is what an edit usually wants.
 *
 * Usage: node comfy-edit.mjs --ref photo.png --prompt "make it night, add falling snow" [options]
 * Run with --help for every option.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
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
  numberOption,
  readPrompt,
  render,
  renderTimeout,
  runCli,
  timestampedPng,
} from './comfy-common.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const DEFAULT_OUTPUT_DIR = join(here, 'output')
const UPLOAD_SUBFOLDER = 'comfy-helper'
const MODEL = 'flux-2-klein-base-4b-fp8.safetensors'
const TEXT_ENCODER = 'qwen_3_4b.safetensors'
const VAE = 'full_encoder_small_decoder.safetensors'
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
/**
 * Render budget for 1920x1080 worth of pixels, output and references together. Time grows about
 * with the square of that (measured warm: 1 ref at 1MP ~63s, 2 refs ~127s), so the budget does too.
 */
const RENDER_SECONDS_PER_FHD = 90
const RENDER_EXPONENT = 2

const HELP = `comfy-edit — generate one image from a prompt and reference image(s) with the local
ComfyUI (FLUX.2 Klein 4B base): edit a photo, restyle it, or combine subjects from several refs.

Usage:
  node comfy-edit.mjs --ref <image> [--ref <image> ...] --prompt "<text>" [--out <file.png>] [options]
  node comfy-edit.mjs --check     # is ComfyUI up? never launches
  node comfy-edit.mjs --start     # make sure ComfyUI is up, then exit

Prompting: describe the result and say what to keep, e.g. "Change the background to a beach at
sunset. Keep the person's face, pose and clothing exactly the same." With several refs, refer to
them in order ("the woman from the first image wearing the jacket from the second image").

Options:
  --ref <path>        Reference image (png/jpg/webp/bmp). Repeat for several; more refs cost
                      more time and memory.
  --prompt <text>     The edit instruction / image prompt. "-" reads it from stdin.
  --prompt-file <p>   Read the prompt from a UTF-8 text file.
  --out <path>        Where to write the PNG. Default output/comfy-edit-<timestamp>.png
                      next to this script.
  --width <px>        Output width; give --height too. Default: the first ref's size after
  --height <px>       scaling to --megapixels. Multiples of 16 work best.
  --megapixels <mp>   Size each ref is scaled to before encoding. Default 1.
  --seed <n>          Fixed seed for a reproducible image. Default random.
  --steps <n>         Sampler steps. Default 20.
  --cfg <n>           Prompt guidance. Default 5.
  --negative <text>   Negative prompt. Default empty.
  --timeout <s>       Render budget per attempt. Default grows with the square of output +
                      reference pixels: ~90s for one 1MP ref, ~210s for two, ~370s for three;
                      doubled right after a launch.
${COMMON_OPTIONS_HELP}

Output (stdout, one JSON line):
  success: {"ok":true,"path":"<absolute png path>","refs":["..."],"width":1024,"height":1024,
            "seed":123,"prompt":"...","promptId":"...","seconds":42.1,"launched":false,"attempts":1}
            (width/height are null when they follow the first ref)
  failure: {"ok":false,"error":"<message>","code":<exit code>}

Exit codes: 0 ok, 1 render failed, 2 bad arguments, 3 ComfyUI unreachable.`

// --- workflow -----------------------------------------------------------------

/**
 * The API-format graph. `refs` are LoadImage names (already uploaded); `size` is {width, height}
 * or null to follow the first scaled ref.
 */
function buildWorkflow({ prompt, negative, refs, megapixels, size, seed, steps, cfg }) {
  const graph = {}
  let next = 1
  const add = (class_type, inputs) => {
    const id = String(next++)
    graph[id] = { class_type, inputs }
    return id
  }

  const model = add('UNETLoader', { unet_name: MODEL, weight_dtype: 'default' })
  const clip = add('CLIPLoader', { clip_name: TEXT_ENCODER, type: 'flux2', device: 'default' })
  const vae = add('VAELoader', { vae_name: VAE })
  let positive = add('CLIPTextEncode', { text: prompt, clip: [clip, 0] })
  let negativeCond = add('CLIPTextEncode', { text: negative, clip: [clip, 0] })

  let firstScaled
  for (const name of refs) {
    const image = add('LoadImage', { image: name })
    const scaled = add('ImageScaleToTotalPixels', {
      image: [image, 0],
      upscale_method: 'lanczos',
      megapixels,
      resolution_steps: 16,
    })
    firstScaled ??= scaled
    const latent = add('VAEEncode', { pixels: [scaled, 0], vae: [vae, 0] })
    positive = add('ReferenceLatent', { conditioning: [positive, 0], latent: [latent, 0] })
    negativeCond = add('ReferenceLatent', { conditioning: [negativeCond, 0], latent: [latent, 0] })
  }

  let width
  let height
  if (size) {
    ;({ width, height } = size)
  } else {
    const measured = add('GetImageSize', { image: [firstScaled, 0] })
    width = [measured, 0]
    height = [measured, 1]
  }

  const empty = add('EmptyFlux2LatentImage', { width, height, batch_size: 1 })
  const sigmas = add('Flux2Scheduler', { steps, width, height })
  const guider = add('CFGGuider', { model: [model, 0], positive: [positive, 0], negative: [negativeCond, 0], cfg })
  const sampler = add('KSamplerSelect', { sampler_name: 'euler' })
  const noise = add('RandomNoise', { noise_seed: seed })
  const sampled = add('SamplerCustomAdvanced', {
    noise: [noise, 0],
    guider: [guider, 0],
    sampler: [sampler, 0],
    sigmas: [sigmas, 0],
    latent_image: [empty, 0],
  })
  const decoded = add('VAEDecode', { samples: [sampled, 0], vae: [vae, 0] })
  add('SaveImage', { filename_prefix: 'comfy-edit', images: [decoded, 0] })
  return graph
}

// --- main ---------------------------------------------------------------------

function parseCli() {
  try {
    return parseArgs({
      allowPositionals: false,
      options: {
        ...COMMON_OPTIONS,
        ref: { type: 'string', multiple: true },
        prompt: { type: 'string' },
        'prompt-file': { type: 'string' },
        out: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        megapixels: { type: 'string', default: '1' },
        seed: { type: 'string' },
        steps: { type: 'string', default: '20' },
        cfg: { type: 'string', default: '5' },
        negative: { type: 'string', default: '' },
      },
    }).values
  } catch (error) {
    throw new CliError(`${error.message} (see --help)`, EXIT.usage)
  }
}

function checkRef(raw) {
  const path = resolve(raw)
  if (!existsSync(path) || !statSync(path).isFile()) throw new CliError(`reference image not found: ${path}`, EXIT.usage)
  const extension = extname(path).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(extension)) throw new CliError(`reference must be png/jpg/webp/bmp: ${path}`, EXIT.usage)
  // Named by content, so the same image uploads to the same file however often it is sent.
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  return { path, uploadName: `${hash}${extension}` }
}

async function main() {
  const values = parseCli()
  if (values.help) {
    process.stdout.write(`${HELP}\n`)
    process.exit(EXIT.ok)
  }
  configureLog('comfy-edit', values.quiet)
  const session = await connect(values)

  // Validate everything before possibly spending minutes launching ComfyUI.
  if (!values.ref?.length) throw new CliError('at least one --ref <image> is required (use comfy-gen for prompt-only)', EXIT.usage)
  const refs = values.ref.map(checkRef)
  const prompt = await readPrompt(values)
  if ((values.width === undefined) !== (values.height === undefined)) {
    throw new CliError('give both --width and --height, or neither to follow the first ref', EXIT.usage)
  }
  const size =
    values.width === undefined
      ? null
      : { width: intOption('--width', values.width, 64), height: intOption('--height', values.height, 64) }
  const megapixels = numberOption('--megapixels', values.megapixels, 0.05)
  const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 32) : intOption('--seed', values.seed, 0)
  const steps = intOption('--steps', values.steps, 1)
  const cfg = numberOption('--cfg', values.cfg, 0)
  const outPath = values.out ? resolve(values.out) : timestampedPng(DEFAULT_OUTPUT_DIR, 'comfy-edit')

  const refPixels = megapixels * 1024 * 1024
  const outputPixels = size ? size.width * size.height : refPixels
  const timeoutFor = renderTimeout(values.timeout, RENDER_SECONDS_PER_FHD, outputPixels + refs.length * refPixels, RENDER_EXPONENT)

  const result = await render(session, {
    // Uploaded on every attempt; the content-hash name makes a repeat upload harmless.
    prepare: async (client) => {
      const names = []
      for (const ref of refs) names.push(await client.uploadImage(ref.path, { subfolder: UPLOAD_SUBFOLDER, name: ref.uploadName }))
      return buildWorkflow({ prompt, negative: values.negative, refs: names, megapixels, size, seed, steps, cfg })
    },
    timeoutFor,
    describe: `${refs.length} ref${refs.length > 1 ? 's' : ''}, ${size ? `${size.width}x${size.height}` : 'ref size'}, seed ${seed}`,
    outPath,
  })
  finish(
    {
      ok: true,
      path: result.path,
      refs: refs.map((ref) => ref.path),
      width: size?.width ?? null,
      height: size?.height ?? null,
      seed,
      prompt,
      ...result,
    },
    EXIT.ok,
  )
}

runCli(main)
