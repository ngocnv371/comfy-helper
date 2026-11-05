# comfy-helper

Command-line tools that drive a local ComfyUI. They are built to be called by other AI agents.
Logs go to stderr, the result is printed as one JSON line on stdout, and the exit code says what
went wrong. If ComfyUI is not already running at `http://127.0.0.1:8188`, the tools launch it.

| Script | What it does | Model |
|---|---|---|
| `comfy-image.mjs` | Text to image | Z-Image Turbo |
| `comfy-edit.mjs` | Edit from one or more reference images | FLUX.2 Klein |
| `comfy-music.mjs` | Text (plus optional lyrics) to music | ACE-Step 1.5 turbo |

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

`comfy-edit.mjs` prompts work differently. Describe the change you want and say what must stay
the same (see its `--help`). `comfy-music.mjs` takes a style prompt made of comma-separated tags.
