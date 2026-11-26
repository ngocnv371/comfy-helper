#!/usr/bin/env node
/**
 * comfy-icon — comfy-image with a square size and a transparent background. It runs
 * comfy-image.mjs with --width and --height set to --size and --transparent added, and passes
 * every other argument, the JSON output and the exit code through unchanged.
 *
 * Usage: node comfy-icon.mjs --prompt "a single armoured gauntlet glove, upright" --out D:/tmp/gauntlet.png
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timestampedPng } from './comfy-common.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const IMAGE_SCRIPT = join(here, 'comfy-image.mjs')
const DEFAULT_SIZE = 768

const HELP = `comfy-icon — comfy-image with a square size and a transparent background (RGBA PNG).

Usage:
  node comfy-icon.mjs --prompt "<text>" [--size <px>] [--out <file.png>] [comfy-image options]

Options:
  --size <px>   Square size. Default ${DEFAULT_SIZE}.
  --out <path>  Default output/comfy-icon-<timestamp>.png next to this script.

Every other option is comfy-image's, passed through as-is; --width, --height and --transparent
are always set by this script. comfy-image's help follows.
`

const args = process.argv.slice(2)
let size = String(DEFAULT_SIZE)
const passed = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--size') size = args[++i]
  else if (args[i].startsWith('--size=')) size = args[i].slice('--size='.length)
  else passed.push(args[i])
}

if (passed.includes('--help')) process.stdout.write(HELP)
const hasOut = passed.some((arg) => arg === '--out' || arg.startsWith('--out='))
const outArgs = hasOut ? [] : ['--out', timestampedPng(join(here, 'output'), 'comfy-icon')]

// comfy-image's parser keeps the last value of a repeated option, so these come last to win.
const child = spawnSync(process.execPath, [IMAGE_SCRIPT, ...passed, ...outArgs, '--width', size, '--height', size, '--transparent'], {
  stdio: 'inherit',
})
if (child.error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: `could not run comfy-image.mjs: ${child.error.message}`, code: 1 })}\n`)
  process.exit(1)
}
process.exit(child.status ?? 1)
