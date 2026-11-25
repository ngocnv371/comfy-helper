# comfy-helper

Command-line tools that drive a local ComfyUI. They are built to be called by other AI agents.
Logs go to stderr, the result is printed as one JSON line on stdout, and the exit code says what
went wrong. If ComfyUI is not already running at `http://127.0.0.1:8188`, the tools launch it.

| Script | What it does | Model |
|---|---|---|
| `comfy-image.mjs` | Text to image | Z-Image Turbo |
| `comfy-icon.mjs` | Text to game icon with a **transparent background** (RGBA PNG, flat white pictogram) | Z-Image Turbo + BiRefNet |
| `comfy-edit.mjs` | Edit from one or more reference images | FLUX.2 Klein |
| `comfy-music.mjs` | Text (plus optional lyrics) to music | ACE-Step 1.5 turbo |
| `comfy-3d.mjs` | Image to a textured, game-ready GLB | Pixal3D or TRELLIS.2 |

Run any of them with `--help` to see every option.

```bash
node comfy-image.mjs --prompt-file prompt.txt --out D:/tmp/fox.png
```

## Image prompts: write about three paragraphs

**A one-sentence prompt will not give you a good image.** Something like "a red fox in snow"
leaves the model to guess everything else, and you get a flat, generic picture. Write about
**three paragraphs** that describe the image the way a photographer or art director would brief
it:

1. **Subject.** Say who or what is in the picture and what they look like: appearance, clothing,
   pose, expression, materials and textures.
2. **Setting and composition.** Describe where it takes place and what surrounds the subject:
   background, time of day, weather. Then give the framing: shot type, camera angle, lens, depth
   of field, and where the subject sits in the frame.
3. **Light, mood and style.** Describe the light (its direction, quality and colour), the
   palette, the atmosphere, and the medium: photo, film stock, illustration or painting. Add any
   finishing detail.

Example:

> A young red fox stands alert in fresh powder snow, its thick winter coat glowing copper against
> the white, with frost caught in the fur around its muzzle and ears. One front paw is lifted
> mid-step, and its amber eyes look just past the camera.
>
> The fox stands at the edge of a quiet birch forest at dawn. Thin pale trunks fade into soft
> mist behind it, and a few dry grass stalks poke through the snow in the foreground. Low-angle
> shot at the fox's eye level, 200mm telephoto, shallow depth of field, with the fox placed on
> the left third of the frame.
>
> Warm, low sunrise light comes from the right and rims the fur with gold, while the shadows in
> the snow stay cool blue. The mood is calm and crisp. Wildlife photography with natural colour
> and fine detail, as if shot on a full-frame camera, with fine snow drifting through the air.

`comfy-image.mjs` warns when a prompt is under 50 words. It logs the warning to stderr and adds a
`"warning"` field to its JSON output, but it still renders the image.

Long prompts are awkward to quote on a command line, so pass them with `--prompt-file`, or pipe
them in with `--prompt -`.

## Icons: transparent background

`comfy-icon.mjs` always produces an icon with a **transparent background**: an RGBA PNG holding
a flat white pictogram, ready to place over any UI. It renders the icon white on black, then cuts
the black background out to alpha with BiRefNet. Pass `--opaque` only if you want the black
background kept.

Icon prompts are short. Describe only the one object and its shape (for example "A simple icon
of a single armoured gauntlet glove, upright, with a wide flared cuff and the fingers together
pointing up."). The script adds the icon style itself (flat white on black, one object, no text).
Pass `--raw` to send your prompt as-is.

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
