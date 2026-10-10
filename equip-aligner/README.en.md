# Equipment Manual Aligner

> [简体中文](README.md) | English

A small local tool for visually aligning the **8-direction offset `outPositions` and the scale `outScale`** of equipment appearances (out): drag the equipment frame over a reference appearance in a web page, export JSON, then write it back into `assets/configs/equipments.ts` with a script. Pure frontend, zero dependencies, no build step.

## Quick start

1. Start Live Server at the **project root** (VSCode's "Go Live" at the bottom right, port 5500 by default);
2. Open `http://127.0.0.1:5500/equip-aligner/index.html` in a browser;
3. Pick an equipment piece on the left → drag its frame on the canvas in the middle → "Download offsets.json" on the right;
4. Run the write-back from the project root:

```bash
node equip-aligner/apply-offsets.cjs offsets.json             # write back (backs up as .bak automatically)
node equip-aligner/apply-offsets.cjs offsets.json --dry-run  # only shows what would change
```

> Live Server's root must be the project root (so that `../assets/...` resolves); if you start it from another directory, point the "Asset root" field at the top of the page to the correct relative path.
> Do not open it with `file://` by double-clicking — the browser blocks `fetch` and the configs cannot be read.

## Canvas controls

| Action | Effect |
|---|---|
| Left-drag | Move the equipment frame (snaps to 0.1, matching the numeric precision of the config) |
| Arrow keys | Nudge by 1 (Shift = 10, Alt = 0.1) |
| Wheel | Zoom the view centred on the cursor |
| Right-drag | Pan the view |
| Number keys 1~8 | Switch direction |
| F | Next frame |

The toolbar switches action (idle/walk/run/attack…) and the in-frame index — `outPositions` applies to every action, but you should check it under at least the idle frame and one attack frame.

## Multiple directions

- Each direction's position is stored independently; a direction button marked with `•` means it differs from direction 0;
- Most equipment shares the same value across all 8 directions: adjust one direction, then click "**Apply current direction to all 8**";
- Changes are saved into the browser's localStorage live, so a refresh loses nothing; the list on the right can discard a single piece or clear everything.

## Reference appearance (base image)

By default it takes `ROLE_DEFAULT_CLOTH_OUT` from `configs/role`; when that directory has no assets it falls back to the first equipment piece that has an appearance (currently `clothes/out/005`, i.e. the beginner chest). The dropdown lets you pick any equipment appearance as the base image, and the chosen base renders with its own offsets (close to the real overlay effect in game).

## Write-back script

```bash
node equip-aligner/apply-offsets.cjs offsets.json [--dry-run] [--file assets/configs/equipments.ts]
cat offsets.json | node equip-aligner/apply-offsets.cjs -
```

- It replaces only the target entry's `outPositions` block and `outScale` — **every other field, comment and formatting stays byte-identical**; direction comments (`// up` etc.) are generated from `configs/animation.directions`;
- Numerically equivalent values leave the original text untouched (a `-10.0` in the source is not rewritten as `-10`);
- It backs up `equipments.ts.bak` before writing;
- Keys it cannot find are listed and it exits with code 2.

After writing back it is recommended to wait 20 seconds and grep the file on disk to double-check (the editor rewrites files periodically), then run the project's tsc and `tools/test-*.cjs`.

## Self-check

```bash
node equip-aligner/selfcheck.cjs
```

Three checks: parsing self-check (entry count / directions / frame-number formula), **round-trip consistency** (full export → write-back → byte-identical to the source file), and changed-value write-back (the diff lands only on the target equipment). Run it after touching `index.html` or the write-back script to catch regressions.

## Rendering convention (why what the page draws is what the game shows)

- The character node's anchor is `(0.5, 0)` with its origin at the **centre of the feet**; the appearance is its child, positioned at `outPositions[direction index]` and scaled by `outScale` (see `RoleAppearance.applyOutTransform`);
- The appearance Sprite uses RAW size with the default anchor `(0.5, 0.5)`: the node position is therefore the **centre of the frame's original canvas**. Even when a frame is auto-trimmed, the engine puts the trimmed content back onto the original canvas by its offset — so drawing the full PNG centred on the node position on this page is exactly equivalent to how the game renders it;
- Frame number = action segment start + direction index × frames per direction for that action + in-frame index (`fillAnimationMap` in `configs/animation`), and the frame file name = the frame number padded to 5 digits + `.PNG`.

The equipment table, action table and direction order are all **parsed live from the project source**; this directory keeps no second copy of the data. After changing the configs, click "Reload config" to apply.

## Limits of the first version

- Only the **appearance (out)** is aligned; the inner view `inPosition` / `inScaleX/Y` / `inRotate` is not covered (those fields are absent from the exported JSON, and the write-back script never touches them);
- Equipment with `out: ""` (no appearance assets) is greyed out in the list — selectable to look at, but dragging means nothing;
- The 15 prefix/suffix variants share one appearance, so aligning the base entry is enough, and the write-back lands only on base entries.
