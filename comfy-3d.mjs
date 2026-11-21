#!/usr/bin/env node
/**
 * comfy-3d — turn one image into a textured, game-ready GLB with the local ComfyUI (Pixal3D or
 * TRELLIS.2), for agents: same io contract and auto-launch as comfy-image.
 *
 * The graph is comfy-3d.json beside this script (exported from the "Pixal3D & TRELLIS.2"
 * workflow in API format). The image is uploaded and fed to its LoadImage; the helper then sets
 * the decimation target, the texture bake size, the seeds, the backend switch and the background
 * removal switch, and keeps only the nodes the Save 3D node depends on. The workflow's 3D
 * previews (raw voxel mesh, vertex-painted mesh) and UV atlas preview are dropped, so a run
 * neither spends time on them nor leaves extra files in ComfyUI's output folder.
 *
 * Texture size dominates the GLB's file size: the mesh of a 9k-face model is ~0.5 MB, while a
 * 4096² base colour + ORM + normal set adds ~11 MB of PNGs, a 1024² set ~2 MB. The default,
 * 512, suits a small game prop; ask for more only for models seen close up.
 *
 * Usage: node comfy-3d.mjs --image lantern.png [--faces 8000] [--texture 512] [options]
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
  render,
  runCli,
  timestampedFile,
} from './comfy-common.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const DEFAULT_WORKFLOW = join(here, 'comfy-3d.json')
const DEFAULT_OUTPUT_DIR = join(here, 'output')
const UPLOAD_SUBFOLDER = 'comfy-helper'
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
const TEXTURE_SIZES = [512, 1024, 2048, 4096]
/** Ambient occlusion is low-frequency; baking it above this only costs time. */
const MAX_AO_SIZE = 1024
const MODELS = ['pixal3d', 'trellis2']
/**
 * Render budget per attempt, doubled right after a launch while the models load. Measured warm:
 * a 9k-face run took ~350s with 4096² textures, an 8k-face run ~275s with 1024².
 */
const RENDER_SECONDS = 900

const HELP = `comfy-3d — generate one textured 3D model (GLB) from an image with the local ComfyUI
(Pixal3D or TRELLIS.2: shape, remesh, decimate, UV unwrap, then bake base colour, metallic /
roughness, ambient occlusion and normal maps).

Usage:
  node comfy-3d.mjs --image <file> [--out <file.glb>] [options]
  node comfy-3d.mjs --check     # is ComfyUI up? never launches
  node comfy-3d.mjs --start     # make sure ComfyUI is up, then exit

Input: one object, whole and centred, on a plain background (the background is removed
unless --keep-background). A three-quarter view shows the most of the shape.

Options:
  --image <path>      The source image (png/jpg/webp/bmp). Required.
  --out <path>        Where to write the GLB. Default output/comfy-3d-<timestamp>.glb next to
                      this script.
  --faces <n>         Target triangle count after decimation. Default: the workflow's (9000).
  --texture <px>      Texture bake size: ${TEXTURE_SIZES.join(', ')}. Default: the workflow's (512).
                      Base colour, metallic/roughness and normal maps use it; ambient occlusion
                      is capped at ${MAX_AO_SIZE}. Texture bytes grow ~4x per step up: a 9k-face
                      model is ~2.5 MB at 1024 and ~12 MB at 4096.
  --model <m>         pixal3d (default) or trellis2.
  --keep-background   Do not remove the background (the image is already cut out).
  --seed <n>          Fixed seed for a reproducible model. Default random.
  --timeout <s>       Render budget per attempt. Default ${RENDER_SECONDS}, doubled right after a launch.
  --workflow <path>   API-format workflow JSON. Default comfy-3d.json next to this script.
${COMMON_OPTIONS_HELP}

Output (stdout, one JSON line):
  success: {"ok":true,"path":"<absolute glb path>","bytes":1234567,"triangles":8983,
            "textures":[{"mimeType":"image/png","bytes":123456,"width":1024,"height":1024}],
            "faces":9000,"texture":512,"model":"pixal3d","seed":123,"image":"<abs path>",
            "promptId":"...","seconds":312.4,"launched":false,"attempts":1}
  failure: {"ok":false,"error":"<message>","code":<exit code>}

Exit codes: 0 ok, 1 render failed, 2 bad arguments, 3 ComfyUI unreachable.`

// --- workflow -----------------------------------------------------------------

/** The one node of `classType` (and title, when given); a workflow that changed shape is a usage error. */
function theNode(workflow, classType, title) {
  const matches = Object.entries(workflow).filter(
    ([, node]) => node.class_type === classType && (title === undefined || title.test(node._meta?.title ?? '')),
  )
  const label = title ? `${classType} titled ${title}` : classType
  if (matches.length !== 1) throw new CliError(`workflow must have exactly one ${label}, found ${matches.length}`, EXIT.usage)
  return matches[0]
}

/** Only the nodes `rootId` depends on, so every other output node (the previews) is dropped. */
function ancestorsOf(workflow, rootId) {
  const kept = {}
  const visit = (id) => {
    if (kept[id]) return
    const node = workflow[id]
    if (!node) throw new CliError(`workflow links to missing node ${id}`, EXIT.usage)
    kept[id] = node
    for (const value of Object.values(node.inputs ?? {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') visit(value[0])
    }
  }
  visit(rootId)
  return kept
}

function loadWorkflow(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new CliError(`cannot read workflow ${path}: ${error.message}`, EXIT.usage)
  }
}

/** The workflow's current decimation target and texture size: the defaults when no flag is given. */
function workflowDefaults(workflow) {
  return {
    faces: theNode(workflow, 'DecimateMesh')[1].inputs.target_face_count,
    texture: theNode(workflow, 'PrimitiveInt', /texture resolution/i)[1].inputs.value,
  }
}

function prepareWorkflow(base, { imageName, faces, texture, model, removeBackground, seed }) {
  const workflow = structuredClone(base)
  theNode(workflow, 'LoadImage')[1].inputs.image = imageName
  theNode(workflow, 'DecimateMesh')[1].inputs.target_face_count = faces
  // Feeds the UV unwrap (texel padding) and the base colour / metallic / roughness bake.
  theNode(workflow, 'PrimitiveInt', /texture resolution/i)[1].inputs.value = texture
  theNode(workflow, 'BakeNormalMapFromMesh')[1].inputs.resolution = texture
  theNode(workflow, 'BakeAmbientOcclusion')[1].inputs.resolution = Math.min(texture, MAX_AO_SIZE)
  theNode(workflow, 'PrimitiveBoolean', /trellis2/i)[1].inputs.value = model === 'trellis2'
  theNode(workflow, 'ComfySwitchNode', /remove background/i)[1].inputs.switch = removeBackground
  // Each stage gets its own seed, derived from the one we report.
  Object.values(workflow)
    .filter((node) => node.class_type === 'KSampler')
    .forEach((node, index) => {
      node.inputs.seed = (seed + index) % 2 ** 32
    })
  const [saveId, save] = theNode(workflow, 'Save3DAdvanced')
  save.inputs.filename_prefix = '3d/comfy-3d'
  return ancestorsOf(workflow, saveId)
}

// --- GLB ----------------------------------------------------------------------

const isGlb = (bytes) => bytes.length >= 20 && bytes.subarray(0, 4).toString('latin1') === 'glTF'

/** Triangle count and embedded textures of a GLB, for the result line; null if it cannot be read. */
function describeGlb(path) {
  try {
    const bytes = readFileSync(path)
    const jsonLength = bytes.readUInt32LE(12)
    const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'))
    const binStart = 20 + jsonLength + 8
    let triangles = 0
    for (const mesh of gltf.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) {
        if ((primitive.mode ?? 4) !== 4) continue
        const accessor = gltf.accessors[primitive.indices ?? primitive.attributes.POSITION]
        triangles += Math.floor(accessor.count / 3)
      }
    }
    const textures = (gltf.images ?? []).map((image) => {
      const view = gltf.bufferViews?.[image.bufferView]
      const info = { mimeType: image.mimeType ?? null, bytes: view?.byteLength ?? null, width: null, height: null }
      if (view && image.mimeType === 'image/png') {
        const start = binStart + (view.byteOffset ?? 0)
        info.width = bytes.readUInt32BE(start + 16)
        info.height = bytes.readUInt32BE(start + 20)
      }
      return info
    })
    return { triangles, textures }
  } catch {
    return null
  }
}

// --- main ---------------------------------------------------------------------

function parseCli() {
  try {
    return parseArgs({
      allowPositionals: false,
      options: {
        ...COMMON_OPTIONS,
        image: { type: 'string' },
        out: { type: 'string' },
        faces: { type: 'string' },
        texture: { type: 'string' },
        model: { type: 'string', default: 'pixal3d' },
        'keep-background': { type: 'boolean', default: false },
        seed: { type: 'string' },
        workflow: { type: 'string' },
      },
    }).values
  } catch (error) {
    throw new CliError(`${error.message} (see --help)`, EXIT.usage)
  }
}

function checkImage(raw) {
  if (!raw) throw new CliError('an image is required: --image <path>', EXIT.usage)
  const path = resolve(raw)
  if (!existsSync(path) || !statSync(path).isFile()) throw new CliError(`image not found: ${path}`, EXIT.usage)
  const extension = extname(path).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(extension)) throw new CliError(`image must be png/jpg/webp/bmp: ${path}`, EXIT.usage)
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
  configureLog('comfy-3d', values.quiet)
  const session = await connect(values)

  // Validate everything before possibly spending minutes launching ComfyUI.
  const image = checkImage(values.image)
  const base = loadWorkflow(values.workflow ? resolve(values.workflow) : DEFAULT_WORKFLOW)
  const defaults = workflowDefaults(base)
  const faces = values.faces === undefined ? defaults.faces : intOption('--faces', values.faces, 100)
  const texture = values.texture === undefined ? defaults.texture : intOption('--texture', values.texture, 1)
  if (!TEXTURE_SIZES.includes(texture)) throw new CliError(`--texture must be one of ${TEXTURE_SIZES.join(', ')}, got ${texture}`, EXIT.usage)
  const model = values.model.toLowerCase()
  if (!MODELS.includes(model)) throw new CliError(`--model must be one of ${MODELS.join(', ')}, got ${values.model}`, EXIT.usage)
  const removeBackground = !values['keep-background']
  const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 32) : intOption('--seed', values.seed, 0)
  const outPath = values.out ? resolve(values.out) : timestampedFile(DEFAULT_OUTPUT_DIR, 'comfy-3d', 'glb')
  // Build once up front so a workflow that changed shape fails before any launch.
  prepareWorkflow(base, { imageName: image.uploadName, faces, texture, model, removeBackground, seed })

  const budgetMs = (values.timeout === undefined ? RENDER_SECONDS : intOption('--timeout', values.timeout, 1)) * 1000
  const timeoutFor = (launchedNow) => (launchedNow && values.timeout === undefined ? 2 * budgetMs : budgetMs)

  const result = await render(session, {
    prepare: async (client) => {
      const imageName = await client.uploadImage(image.path, { subfolder: UPLOAD_SUBFOLDER, name: image.uploadName })
      return prepareWorkflow(base, { imageName, faces, texture, model, removeBackground, seed })
    },
    timeoutFor,
    describe: `${model}, ${faces} faces, ${texture}px textures, seed ${seed}`,
    outPath,
    output: { key: '3d', kind: '3D model', isValid: isGlb, format: 'a GLB' },
  })
  const glb = describeGlb(result.path)
  finish(
    {
      ok: true,
      path: result.path,
      bytes: statSync(result.path).size,
      triangles: glb?.triangles ?? null,
      textures: glb?.textures ?? null,
      faces,
      texture,
      model,
      seed,
      image: image.path,
      ...result,
    },
    EXIT.ok,
  )
}

runCli(main)
