#!/usr/bin/env node
/**
 * comfy-music — render one piece of music from a style prompt (and optional lyrics) with the
 * local ComfyUI (ACE-Step 1.5 turbo), for agents: same io contract and auto-launch as comfy-image.
 *
 * The graph follows comfy-music.json: the prompt goes to TextEncodeAceStepAudio1.5 as its tags,
 * along with lyrics, BPM, key, time signature and language; its language model writes audio codes
 * first (generate_audio_codes), then the turbo DiT samples 8 steps at CFG 1 through
 * ModelSamplingAuraFlow (shift 3) and the audio VAE decodes. No lyrics means an instrumental.
 *
 * Usage: node comfy-music.mjs --prompt "lofi hip hop, warm rhodes, vinyl crackle" --duration 90 [options]
 * Run with --help for every option.
 */
import { readFileSync } from 'node:fs'
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
  numberOption,
  readPrompt,
  render,
  runCli,
  timestampedFile,
} from './comfy-common.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const DEFAULT_OUTPUT_DIR = join(here, 'output')
const MODEL = {
  unet: 'acestep_v1.5_turbo.safetensors',
  textEncoders: ['qwen_0.6b_ace15.safetensors', 'qwen_1.7b_ace15.safetensors'],
  vae: 'ace_1.5_vae.safetensors',
  steps: 8,
  cfg: 1,
  shift: 3,
}
const MAX_DURATION = 600

const startsWith = (bytes, text) => bytes.subarray(0, text.length).toString('latin1') === text
/** Save node, its quality choices, and how to recognise the file it writes. */
const FORMATS = {
  mp3: {
    node: 'SaveAudioMP3',
    qualities: ['V0', '128k', '320k'],
    quality: 'V0',
    // An ID3 tag, or straight into an MPEG frame sync.
    isValid: (bytes) => startsWith(bytes, 'ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0),
  },
  opus: {
    node: 'SaveAudioOpus',
    qualities: ['64k', '96k', '128k', '192k', '320k'],
    quality: '128k',
    isValid: (bytes) => startsWith(bytes, 'OggS'),
  },
  flac: { node: 'SaveAudio', qualities: [], quality: null, isValid: (bytes) => startsWith(bytes, 'fLaC') },
}
const TIME_SIGNATURES = ['2', '3', '4', '6']
const KEYS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'].flatMap((note) => [
  `${note} major`,
  `${note} minor`,
])
const LANGUAGES =
  'ar az bg bn ca cs da de el en es fa fi fr he hi hr ht hu id is it ja ko la lt ms ne nl no pa pl pt ro ru sa sk sr sv sw ta te th tl tr uk ur vi yue zh unknown'.split(
    ' ',
  )
/**
 * Render budget: a fixed part (the language model writing audio codes, VAE decode) plus a part
 * per minute of audio; doubled right after a launch while the models load. Measured warm: 30s of
 * audio ~14s, 1 min ~17s, 3 min with lyrics ~58s, 10 min ~177s.
 */
const RENDER_BASE_SECONDS = 30
const RENDER_SECONDS_PER_MINUTE = 40

const HELP = `comfy-music — generate one piece of music from a style prompt and optional lyrics with the
local ComfyUI (ACE-Step 1.5 turbo).

Usage:
  node comfy-music.mjs --prompt "<style>" [--lyrics-file song.txt] [--out <file.mp3>] [options]
  node comfy-music.mjs --check     # is ComfyUI up? never launches
  node comfy-music.mjs --start     # make sure ComfyUI is up, then exit

Prompting: describe genre, instruments, mood, tempo feel and vocals, e.g. "upbeat synthwave,
punchy drums, analog bass, female vocals, 80s". Lyrics take section tags on their own lines
([verse], [chorus], [bridge], [outro]); leave them out for an instrumental.

Options:
  --prompt <text>     Style / tags of the music. "-" reads it from stdin.
  --prompt-file <p>   Read the prompt from a UTF-8 text file.
  --lyrics <text>     Lyrics to sing. Default none (instrumental).
  --lyrics-file <p>   Read the lyrics from a UTF-8 text file.
  --duration <s>      Length in seconds, 1-${MAX_DURATION}. Default 60.
  --bpm <n>           Tempo, 10-300. Default 120.
  --key <key>         Key and scale, e.g. "E minor", "F# major". Default "C major".
  --time-signature <n>  Beats per bar: ${TIME_SIGNATURES.join(', ')}. Default 4.
  --language <code>   Lyrics language (en, ja, zh, es, ...). Default en.
  --format <f>        mp3 (default), opus or flac.
  --quality <q>       mp3: ${FORMATS.mp3.qualities.join(', ')} (default ${FORMATS.mp3.quality}); opus: ${FORMATS.opus.qualities.join(', ')}
                      (default ${FORMATS.opus.quality}); flac is lossless and takes none.
  --out <path>        Where to write the file. Default output/comfy-music-<timestamp>.<format>
                      next to this script.
  --seed <n>          Fixed seed for a reproducible piece. Default random.
  --steps <n>         Sampler steps. Default ${MODEL.steps}.
  --no-audio-codes    Skip the language model that plans the audio codes: faster, usually worse.
  --timeout <s>       Render budget per attempt. Default ${RENDER_BASE_SECONDS}s + ${RENDER_SECONDS_PER_MINUTE}s per minute of audio,
                      doubled right after a launch.
${COMMON_OPTIONS_HELP}

Output (stdout, one JSON line):
  success: {"ok":true,"path":"<absolute audio path>","format":"mp3","duration":60,"bpm":120,
            "key":"C major","timeSignature":"4","language":"en","seed":123,"prompt":"...",
            "lyrics":"...","promptId":"...","seconds":42.1,"launched":false,"attempts":1}
  failure: {"ok":false,"error":"<message>","code":<exit code>}

Exit codes: 0 ok, 1 render failed, 2 bad arguments, 3 ComfyUI unreachable.`

// --- workflow -----------------------------------------------------------------

/** The API-format graph, as in comfy-music.json. */
function buildWorkflow({ prompt, lyrics, duration, bpm, key, timeSignature, language, audioCodes, seed, steps, format, quality }) {
  const graph = {}
  let next = 1
  const add = (class_type, inputs) => {
    const id = String(next++)
    graph[id] = { class_type, inputs }
    return id
  }

  const unet = add('UNETLoader', { unet_name: MODEL.unet, weight_dtype: 'default' })
  const model = add('ModelSamplingAuraFlow', { shift: MODEL.shift, model: [unet, 0] })
  const [clipName1, clipName2] = MODEL.textEncoders
  const clip = add('DualCLIPLoader', { clip_name1: clipName1, clip_name2: clipName2, type: 'ace', device: 'default' })
  const vae = add('VAELoader', { vae_name: MODEL.vae })
  const positive = add('TextEncodeAceStepAudio1.5', {
    tags: prompt,
    lyrics,
    seed,
    bpm,
    duration,
    timesignature: timeSignature,
    language,
    keyscale: key,
    generate_audio_codes: audioCodes,
    cfg_scale: 2,
    temperature: 0.85,
    top_p: 0.9,
    top_k: 0,
    min_p: 0,
    clip: [clip, 0],
  })
  const negative = add('ConditioningZeroOut', { conditioning: [positive, 0] })
  const empty = add('EmptyAceStep1.5LatentAudio', { seconds: duration, batch_size: 1 })
  const sampled = add('KSampler', {
    seed,
    steps,
    cfg: MODEL.cfg,
    sampler_name: 'euler',
    scheduler: 'simple',
    denoise: 1,
    model: [model, 0],
    positive: [positive, 0],
    negative: [negative, 0],
    latent_image: [empty, 0],
  })
  const decoded = add('VAEDecodeAudio', { samples: [sampled, 0], vae: [vae, 0] })
  const save = { filename_prefix: 'audio/comfy-music', audio: [decoded, 0] }
  if (quality !== null) save.quality = quality
  add(FORMATS[format].node, save)
  return graph
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
        lyrics: { type: 'string' },
        'lyrics-file': { type: 'string' },
        duration: { type: 'string', default: '60' },
        bpm: { type: 'string', default: '120' },
        key: { type: 'string', default: 'C major' },
        'time-signature': { type: 'string', default: '4' },
        language: { type: 'string', default: 'en' },
        format: { type: 'string', default: 'mp3' },
        quality: { type: 'string' },
        out: { type: 'string' },
        seed: { type: 'string' },
        steps: { type: 'string' },
        'no-audio-codes': { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    throw new CliError(`${error.message} (see --help)`, EXIT.usage)
  }
}

/** The allowed value matching `raw` case-insensitively (and spacing-insensitively). */
function choice(flag, raw, allowed) {
  const normal = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim()
  const match = allowed.find((value) => normal(value) === normal(raw))
  if (match === undefined) throw new CliError(`${flag} must be one of ${allowed.join(', ')}; got ${raw}`, EXIT.usage)
  return match
}

async function main() {
  const values = parseCli()
  if (values.help) {
    process.stdout.write(`${HELP}\n`)
    process.exit(EXIT.ok)
  }
  configureLog('comfy-music', values.quiet)
  const session = await connect(values)

  // Validate everything before possibly spending minutes launching ComfyUI.
  const prompt = await readPrompt(values)
  if (values.lyrics !== undefined && values['lyrics-file'] !== undefined) {
    throw new CliError('give --lyrics or --lyrics-file, not both', EXIT.usage)
  }
  const lyrics = (values['lyrics-file'] ? readFileSync(resolve(values['lyrics-file']), 'utf8') : (values.lyrics ?? '')).trim()
  const duration = numberOption('--duration', values.duration, 1)
  if (duration > MAX_DURATION) throw new CliError(`--duration must be at most ${MAX_DURATION}, got ${values.duration}`, EXIT.usage)
  const bpm = intOption('--bpm', values.bpm, 10)
  if (bpm > 300) throw new CliError(`--bpm must be at most 300, got ${values.bpm}`, EXIT.usage)
  const key = choice('--key', values.key, KEYS)
  const timeSignature = choice('--time-signature', values['time-signature'], TIME_SIGNATURES)
  const language = choice('--language', values.language, LANGUAGES)
  const format = choice('--format', values.format, Object.keys(FORMATS))
  const { qualities, quality: defaultQuality, isValid } = FORMATS[format]
  if (values.quality !== undefined && !qualities.length) throw new CliError(`--quality does not apply to ${format}`, EXIT.usage)
  const quality = values.quality === undefined ? defaultQuality : choice('--quality', values.quality, qualities)
  const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 32) : intOption('--seed', values.seed, 0)
  const steps = values.steps === undefined ? MODEL.steps : intOption('--steps', values.steps, 1)
  const audioCodes = !values['no-audio-codes']
  const outPath = values.out ? resolve(values.out) : timestampedFile(DEFAULT_OUTPUT_DIR, 'comfy-music', format)

  const budgetMs =
    values.timeout === undefined
      ? Math.ceil(RENDER_BASE_SECONDS + (RENDER_SECONDS_PER_MINUTE * duration) / 60) * 1000
      : intOption('--timeout', values.timeout, 1) * 1000
  const timeoutFor = (launchedNow) => (launchedNow && values.timeout === undefined ? 2 * budgetMs : budgetMs)

  const workflow = buildWorkflow({ prompt, lyrics, duration, bpm, key, timeSignature, language, audioCodes, seed, steps, format, quality })
  const result = await render(session, {
    prepare: async () => workflow,
    timeoutFor,
    describe: `${duration}s ${format}, ${bpm} bpm, ${key}, ${lyrics ? 'with lyrics' : 'instrumental'}, seed ${seed}`,
    outPath,
    output: { key: 'audio', kind: 'audio', isValid, format: `${format} audio` },
  })
  finish(
    { ok: true, path: result.path, format, duration, bpm, key, timeSignature, language, seed, prompt, lyrics, ...result },
    EXIT.ok,
  )
}

runCli(main)
