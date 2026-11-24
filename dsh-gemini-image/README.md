# dsh-gemini-image

Generate and edit images from a DeepSeek Harness session, with Google's
Gemini Nano Banana 2.1 model and the Google API key the profile already holds.

## The tool

`generate_image(prompt, aspect_ratio?, image_size?, reference_images?)`

| Parameter          | Meaning                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `prompt`           | What to draw or change; name each reference's role here.                                 |
| `aspect_ratio`     | 14 ratios from `1:1` to `21:9`, plus the wide `1:4`, `4:1`, `1:8`, `8:1`. Default `1:1`. |
| `image_size`       | `1K` or `2K`; default `1K`. 4K is not allowed.                                           |
| `reference_images` | Up to 4 paths, to keep a character or product consistent, or to edit.                    |

The model is fixed to `gemini-nano-banana-2.1`. Thinking level, grounding,
seeds, and the output path are decided by the plugin — the API defaults apply —
so the tool stays small and the cost of a call stays predictable.

A vision-capable model sees the generated image in the tool result. A text-only
route receives the standard omission placeholder plus the file path.

## Where the files go

Every image is written to `generated/` inside this package, beside the plugin's
own files.

## The Google key

The tool reads the credential reference `GOOGLE_API_KEY` by default — the same
reference the profile's Google chat provider uses, so one key serves both and
there is nothing new to configure. Set it in **Settings › Models**, or export
`GOOGLE_API_KEY` before starting the Harness.

## Images in context

An attached image rides every later model request, so the default keeps only
the **newest** generated image in context. Each new result logs the shipped
`image/offload` decision for the older ones: later requests carry placeholder
text for them, their files stay on disk, and the transcript still shows them.

Turn **Keep every generated image in context** on, on this plugin's row in
**Plugins**, to keep them all. Offload is permanent, so switching it back on
does not restore images generated while it was off — the toggle governs later
generations.
