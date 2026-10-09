# Contributing

## Set up

    bun install
    bun test
    bunx tsc --noEmit

Use Bun 1.4.2. `bun.lock` uses `lockfileVersion: 2`, and an older Bun rejects it.

## What lives where

`jobs.ts` is the extension. `host.ts` is a stand-in for the Pi host, and `jobs.test.ts` drives the
extension through it. Every case calls the host surface: `host.call`, `host.emit`, `host.messages`,
`host.entries`. No test reads a variable inside the extension. Keep it that way, because the host
surface is what Pi actually calls, and a test that reaches inside survives a broken registration.

`jobs-rpc.ts` runs one real turn against a real model. It costs tokens and takes about a minute, so
it stays out of `bun test`. Run it when a change touches the wake-up path.

`bench.ts` prints the tables the README quotes.

## Rules for a change

- A behavior change carries a test through the host seam. A test that only reads the source proves
  the source exists.
- A new `PI_JOBS_*` setting carries a row in the README table and a line in the header comment of
  `jobs.ts`.
- A number in the README comes from a run on that version. Re-run `bun bench.ts` before you quote a
  table again.
- Keep the POSIX assumption. A job runs with `detached: true` and the extension kills the process
  group with `process.kill(-pid, ...)`. Do not add platform checks for Windows; the tool does not
  support native Windows.

## The gallery image

`assets/gallery.png` is drawn, not screenshotted. `bun gallery/capture.ts` runs the extension against
the test host and prints the widget lines and the footer text as JSON. `gallery/render.py` draws those
bytes into a 1200 x 630 PNG with Menlo from `/System/Library/Fonts/Menlo.ttc`. It needs Pillow, which
the repo does not carry:

```bash
python3 -m venv /tmp/imgvenv && /tmp/imgvenv/bin/pip install pillow
bun gallery/capture.ts > /tmp/cap.json
/tmp/imgvenv/bin/python gallery/render.py /tmp/cap.json assets/gallery.png
```

Never type rows into `render.py` by hand. If the text in the image cannot come from a run, do not
change the image.

## Report a bug

Include the Pi version, the Bun version, the OS, every `PI_JOBS_*` setting you set, the file mode of
one log file, and the output of `pgrep -g <pid>` for a job that would not die.

## Release

Maintainers only. Green CI on `main`, an annotated tag, a GitHub release, then `npm publish --access
public`. A published version never changes. A fix gets the next number.
