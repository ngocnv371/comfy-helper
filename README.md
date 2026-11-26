# comfy-helper

Command-line tools that drive a local ComfyUI. They are built to be called by other AI agents.
Logs go to stderr, the result is printed as one JSON line on stdout, and the exit code says what
went wrong. If ComfyUI is not already running at `http://127.0.0.1:8188`, the tools launch it.

| Script | What it does | Model |
|---|---|---|
| `comfy-image.mjs` | Text to image, optionally with a transparent background (`--transparent`) | Z-Image Turbo (+ BiRefNet) |
| `comfy-icon.mjs` | `comfy-image.mjs` forced to a square with a **transparent background** | Z-Image Turbo + BiRefNet |
| `comfy-edit.mjs` | Edit from one or more reference images | FLUX.2 Klein |
| `comfy-music.mjs` | Text (plus optional lyrics) to music | ACE-Step 1.5 turbo |
| `comfy-3d.mjs` | Image to a textured, game-ready GLB | Pixal3D or TRELLIS.2 |

Run any of them with `--help` to see every option.

```bash
node comfy-image.mjs --prompt-file prompt.txt --out D:/tmp/fox.png
```

## Image prompts: the four elements, most important first

**A one-sentence prompt will not give you a good image.** Something like "a red fox in snow"
leaves the model to guess everything else, and you get a flat, generic picture. A good Z-Image
prompt covers four elements. **Put the most important content at the very beginning**: the model
gives more weight to the words that come first.

1. **Subject.** Be specific: who or what it is, pose, clothing, expression, materials and
   textures.
2. **Style.** Name the medium: oil painting, photography, 3D render, anime, ink painting, a film
   stock.
3. **Lighting and atmosphere.** For example golden hour, neon glow, soft window light, dramatic
   shadows, plus the mood and palette.
4. **Composition and quality.** For example close-up, wide-angle, shallow depth of field,
   centred composition. Use quality modifiers like "high detail" sparingly, two or three at most.

Example:

> A young red fox stands alert in fresh powder snow, its thick winter coat glowing copper against
> the white, with frost caught in the fur around its muzzle and ears. One front paw is lifted
> mid-step, and its amber eyes look just past the camera. It stands at the edge of a quiet birch
> forest, thin pale trunks fading into soft mist behind it.
>
> Wildlife photography, natural colour, as if shot on a full-frame camera. Warm, low sunrise
> light comes from the right and rims the fur with gold, while the shadows in the snow stay cool
> blue; the mood is calm and crisp, with fine snow drifting through the air. Low-angle shot at
> the fox's eye level, 200mm telephoto, shallow depth of field, the fox on the left third of the
> frame.

A realistic portrait can lead with the style instead, when the look matters most:

> Film grain, analog film texture, soft film lighting, Kodak Portra 400 style. Close-up shot of a
> young East Asian woman standing in a snowy outdoor scene, wearing a blue and white thick coat
> and a dark gray helmet, with dark long straight hair slightly messy in the wind, looking up
> with a slightly surprised expression, natural daylight, fresh and natural tones.

`comfy-image.mjs` warns when a prompt is under 50 words. It logs the warning to stderr and adds a
`"warning"` field to its JSON output, but it still renders the image.

### Text in the image

Z-Image can render readable English and Chinese text. To get it reliably:

- Wrap the text in straight double quotes: `"MORNING BLEND"`, `"新年快乐"`.
- Describe the lettering: serif, handwritten, neon, calligraphy, and so on.
- Keep it short. One word or a short phrase per image works best.

> Red Chinese New Year poster, with the four golden calligraphy characters "新年快乐" in the
> center, surrounded by plum blossoms and lanterns at the edges, traditional ink painting style.

### Pitfalls

- **Don't write negatives in the prompt.** "No people" can make people appear. Describe the
  empty scene you want instead (or use `--negative`).
- **Don't mix conflicting styles.** "Realistic anime watercolor 3D render" confuses the model.
  Pick one primary style.

Long prompts are awkward to quote on a command line, so pass them with `--prompt-file`, or pipe
them in with `--prompt -`.

## Transparent backgrounds and icons

`comfy-image.mjs --transparent` cuts the background out with BiRefNet and writes an RGBA PNG. It
works best when the prompt puts one subject on a plain, contrasting background.

`comfy-icon.mjs` runs `comfy-image.mjs` with `--transparent` and a square size (`--size`, default
768). It adds nothing to the prompt, so write it like any other image prompt. Every other option
is passed through to `comfy-image.mjs`.

## 3D models: keep textures small

`comfy-3d.mjs` takes one image of a single object and writes a GLB. The background is removed
first. It then decimates the model to `--faces` triangles (default 9000) and bakes base colour,
metallic/roughness, ambient occlusion and normal maps at `--texture` pixels (default 512).

Texture size, not face count, decides how big the file is. A 9k-face mesh takes about 0.5 MB.
At 4096 the textures add about 11 MB, while at 1024 they add about 2 MB (half of that is the
normal map), and 512 cuts that by about four times again. Raise `--texture` only for a model
that will be seen close up.

## Music: tags drive the sound

`comfy-music.mjs` takes three things that matter most: the tags (`--prompt`), the tempo
(`--bpm`) and the lyrics (`--lyrics` or `--lyrics-file`).

**Tags do the heavy lifting.** Pass them as comma-separated tags and be specific about genre,
mood, texture, instruments and vocals: `"lo-fi hip-hop, mellow, vinyl crackle, rhodes piano, soft
drums, 75 BPM"` gives you far more than `"chill music"`. Put the tempo in the tags too, and set
`--bpm` to the same number (it defaults to 120).

### Instrumental

Let the tags drive it and set the lyrics to `[inst]`:

```bash
node comfy-music.mjs --prompt "lo-fi hip-hop, mellow, vinyl crackle, rhodes piano, soft drums, 75 BPM" \
  --bpm 75 --lyrics "[inst]" --duration 90
```

If vocals still creep in, add `no vocals` to the tags as well.

### Full vocal song with structure

Name the vocal in the tags, and write the lyrics with section markers (`[Verse]`, `[Chorus]`,
`[Bridge]`, `[Outro]`), each on its own line. Keep the meter of the lines in a section
consistent. A section can hold a short direction instead of lines to sing, as `[Bridge]` and
`[Outro]` do below. Multi-line lyrics are easiest to pass in a file. `song.txt`:

```text
[Verse]
Chalk on the palms, laces double-knotted
Morning on the ridge, the sun is rising
[Chorus]
We rise, we strike, we never fade out
We rise, we strike, we sing it loud
[Bridge]
Soft piano breakdown
[Outro]
Full band, fade
```

```bash
node comfy-music.mjs --prompt "indie pop, anthemic, electric guitar, driving drums, female vocal, 120 BPM" \
  --bpm 120 --lyrics-file song.txt --duration 120
```

### More tips

- **Other languages.** ACE-Step 1.5 sings in 50+ languages. Write the lyrics in the target
  language, name it in the tags (`"japanese vocal, j-pop"`), and pass `--language` (for example
  `--language ja`).
- **Draft short, then render long.** A 30-second piece renders in about 14 seconds, so iterate on
  the tags with `--duration 30` first. Each run prints its `seed` in the JSON output; pass it back
  with `--seed` to keep a result reproducible. Leave `--seed` out to explore variations.

## Other prompts

`comfy-edit.mjs` prompts work differently. Describe the change you want and say what must stay
the same (see its `--help`).
