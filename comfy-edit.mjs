#!/usr/bin/env node
/**
 * comfy-edit — render one image from a prompt plus one or more reference images with the local
 * ComfyUI (FLUX.2 Klein), for agents: same io contract and auto-launch as comfy-image.
 *
 * Each reference is uploaded into ComfyUI's input/comfy-helper folder (named by content hash, so
 * re-sending an image does not pile up copies), scaled to ~1 megapixel, VAE-encoded and chained
 * onto both the positive and negative conditioning with ReferenceLatent. Without --width/--height
 * the output takes the first reference's (scaled) size, which is what an edit usually wants.
 *
 * Two models, each following its ComfyUI template: `turbo` (default) is Klein 9B KV, distilled to
 * 4 steps at CFG 1, with FluxKVCache so the reference tokens are computed once rather than every
 * step ("Flux.2 Klein 9B KV image edit"); `base` is the undistilled Klein 4B at 20 steps, CFG 5
 * ("Image Edit (Flux.2 Klein 4B)") — slower, but it honours --negative.
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
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

/**
 * `secondsPerFhd` is the render budget for 1920x1080 worth of pixels, output and references
 * together; time grows about with the square of that, so the budget does too.
 */
const MODELS = {
  turbo: {
    unet: 'flux-2-klein-9b-kv-fp8.safetensors',
    textEncoder: 'qwen_3_8b_fp8mixed.safetensors',
    vae: 'flux2-vae.safetensors',
    steps: 4,
    cfg: 1,
    kvCache: true,
    secondsPerFhd: 30, // measured warm: 1 ref at 1MP ~15s, 2 refs ~19s, 3 at 0.6MP ~14s
  },
  base: {
    unet: 'flux-2-klein-base-4b-fp8.safetensors',
    textEncoder: 'qwen_3_4b.safetensors',
    vae: 'full_encoder_small_decoder.safetensors',
    steps: 20,
    cfg: 5,
    kvCache: false,
    secondsPerFhd: 90, // measured warm: 1 ref at 1MP ~63s, 2 refs ~127s
  },
}
const RENDER_EXPONENT = 2
/**
 * Default --megapixels: 1 per ref for one or two refs; beyond that the refs share this many, since
 * three 1MP refs run the 24GB card out of VRAM on Klein 9B (three at 0.6MP fit).
 */
const MAX_TOTAL_REF_MEGAPIXELS = 1.8

const HELP = `comfy-edit — generate one image from a prompt and reference image(s) with the local
ComfyUI (FLUX.2 Klein): edit a photo, restyle it, or combine subjects from several refs.

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
  --megapixels <mp>   Size each ref is scaled to before encoding. Default 1, or 1.8 shared out
                      with 3+ refs (three 1MP refs run out of VRAM).
  --model <name>      turbo (default): Klein 9B KV, 4 steps — fast and the better model.
                      base: Klein 4B base, 20 steps at CFG 5 — slower; use it for --negative.
  --seed <n>          Fixed seed for a reproducible image. Default random.
  --steps <n>         Sampler steps. Default 4 (turbo) / 20 (base).
  --cfg <n>           Prompt guidance. Default 1 (turbo) / 5 (base). At 1 the negative prompt
                      has no effect.
  --negative <text>   Negative prompt; needs --cfg above 1. Default none.
  --timeout <s>       Render budget per attempt. Default grows with the square of output +
                      reference pixels (${MODELS.turbo.secondsPerFhd}s turbo / ${MODELS.base.secondsPerFhd}s base for one 1MP ref, ~2.3x that
                      for two, ~4x for three); doubled right after a launch.
${COMMON_OPTIONS_HELP}

Output (stdout, one JSON line):
  success: {"ok":true,"path":"<absolute png path>","model":"turbo","refs":["..."],"width":1024,"height":1024,
            "seed":123,"prompt":"...","promptId":"...","seconds":42.1,"launched":false,"attempts":1}
            (width/height are null when they follow the first ref)
  failure: {"ok":false,"error":"<message>","code":<exit code>}

Exit codes: 0 ok, 1 render failed, 2 bad arguments, 3 ComfyUI unreachable.`

// --- workflow -----------------------------------------------------------------

/**
 * The API-format graph. `refs` are LoadImage names (already uploaded); `size` is {width, height}
 * or null to follow the first scaled ref; `negative` is text or null for none.
 */
function buildWorkflow({ model: profile, prompt, negative, refs, megapixels, size, seed, steps, cfg }) {
  const graph = {}
  let next = 1
  const add = (class_type, inputs) => {
    const id = String(next++)
    graph[id] = { class_type, inputs }
    return id
  }

  let model = add('UNETLoader', { unet_name: profile.unet, weight_dtype: 'default' })
  if (profile.kvCache) model = add('FluxKVCache', { model: [model, 0] })
  const clip = add('CLIPLoader', { clip_name: profile.textEncoder, type: 'flux2', device: 'default' })
  const vae = add('VAELoader', { vae_name: profile.vae })
  let positive = add('CLIPTextEncode', { text: prompt, clip: [clip, 0] })
  // No negative prompt: the turbo template zeroes the positive, the base template encodes "".
  let negativeCond =
    negative === null && profile.kvCache
      ? add('ConditioningZeroOut', { conditioning: [positive, 0] })
      : add('CLIPTextEncode', { text: negative ?? '', clip: [clip, 0] })

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
        megapixels: { type: 'string' },
        model: { type: 'string', default: 'turbo' },
        seed: { type: 'string' },
        steps: { type: 'string' },
        cfg: { type: 'string' },
        negative: { type: 'string' },
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
  if (!values.ref?.length) throw new CliError('at least one --ref <image> is required (use comfy-image for prompt-only)', EXIT.usage)
  const refs = values.ref.map(checkRef)
  const prompt = await readPrompt(values)
  if ((values.width === undefined) !== (values.height === undefined)) {
    throw new CliError('give both --width and --height, or neither to follow the first ref', EXIT.usage)
  }
  const size =
    values.width === undefined
      ? null
      : { width: intOption('--width', values.width, 64), height: intOption('--height', values.height, 64) }
  const megapixels =
    values.megapixels === undefined
      ? Math.min(1, Number((MAX_TOTAL_REF_MEGAPIXELS / refs.length).toFixed(2)))
      : numberOption('--megapixels', values.megapixels, 0.05)
  const model = MODELS[values.model]
  if (!model) throw new CliError(`--model must be one of ${Object.keys(MODELS).join(', ')}, got ${values.model}`, EXIT.usage)
  const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 32) : intOption('--seed', values.seed, 0)
  const steps = values.steps === undefined ? model.steps : intOption('--steps', values.steps, 1)
  const cfg = values.cfg === undefined ? model.cfg : numberOption('--cfg', values.cfg, 0)
  const negative = values.negative ?? null
  if (negative !== null && cfg <= 1) {
    throw new CliError(`--negative has no effect at --cfg ${cfg}; raise --cfg or use --model base`, EXIT.usage)
  }
  const outPath = values.out ? resolve(values.out) : timestampedPng(DEFAULT_OUTPUT_DIR, 'comfy-edit')

  const refPixels = megapixels * 1024 * 1024
  const outputPixels = size ? size.width * size.height : refPixels
  const timeoutFor = renderTimeout(values.timeout, model.secondsPerFhd, outputPixels + refs.length * refPixels, RENDER_EXPONENT)

  const result = await render(session, {
    // Uploaded on every attempt; the content-hash name makes a repeat upload harmless.
    prepare: async (client) => {
      const names = []
      for (const ref of refs) names.push(await client.uploadImage(ref.path, { subfolder: UPLOAD_SUBFOLDER, name: ref.uploadName }))
      return buildWorkflow({ model, prompt, negative, refs: names, megapixels, size, seed, steps, cfg })
    },
    timeoutFor,
    describe: `${values.model}, ${refs.length} ref${refs.length > 1 ? 's' : ''}, ${size ? `${size.width}x${size.height}` : 'ref size'}, seed ${seed}`,
    outPath,
  })
  finish(
    {
      ok: true,
      path: result.path,
      model: values.model,
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
