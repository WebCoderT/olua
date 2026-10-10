# FAQ · Client

> [简体中文](FAQ.md) | English

> Preview errors, engine pitfalls and gameplay configuration questions for the client (Cocos Creator).
>
> Cross-side mechanics (single source of truth for addresses / contract pipeline / how the three sides interact) live in [../FAQ.en.md](../FAQ.en.md);
> admin questions live in [../admin/FAQ.en.md](../admin/FAQ.en.md); the server FAQ lands in a follow-up issue and will be linked here once available.
> Client overview and directory structure: [README.en.md](README.en.md).
>
> In the commands below, `tools/` always means **`client/tools/`** (the client scripts); the few that run from the repository-root `tools/` are written out as `../tools/`.

## Contents

- [Preview reports reading 'width'](#preview-reports-reading-width)
- [The map goes black after teleporting and only comes back when I move](#the-map-goes-black-after-teleporting-and-only-comes-back-when-i-move)
- [A new character has no equipment in the bag after a build](#a-new-character-has-no-equipment-in-the-bag-after-a-build)
- [Clicking a dialog's close button also opens the UI underneath](#clicking-a-dialogs-close-button-also-opens-the-ui-underneath)
- [After clicking an NPC and opening a dialog, why does the character keep walking?](#after-clicking-an-npc-and-opening-a-dialog-why-does-the-character-keep-walking)
- [Moving the mouse reports Cannot read properties of null (reading 'cameraPriority')](#moving-the-mouse-reports-cannot-read-properties-of-null-reading-camerapriority)
- [Every feature inside a dialog suddenly stopped responding (cannot equip, cannot unequip, map clicks do nothing)](#every-feature-inside-a-dialog-suddenly-stopped-responding-cannot-equip-cannot-unequip-map-clicks-do-nothing)
- [How do I tune drops?](#how-do-i-tune-drops)
- [I want to change a number or a piece of text on screen — which file do I edit?](#i-want-to-change-a-number-or-a-piece-of-text-on-screen--which-file-do-i-edit)
- [I want to change the bag "tidy" ordering (ascending / slot order / what comes first)](#i-want-to-change-the-bag-tidy-ordering-ascending--slot-order--what-comes-first)
- [I want to tune the bag "recycle" price (too high / too low, or price one item separately)](#i-want-to-tune-the-bag-recycle-price-too-high--too-low-or-price-one-item-separately)
- [Can a deleted character be recovered? Why is "start game" dead after deleting one?](#can-a-deleted-character-be-recovered-why-is-start-game-dead-after-deleting-one)
- [How do I discard things from the bag? Can a misclick be undone?](#how-do-i-discard-things-from-the-bag-can-a-misclick-be-undone)
- [How do I drag a bag item into another cell?](#how-do-i-drag-a-bag-item-into-another-cell)
- [How is an equipment's glowing border (quality effect) chosen? Where do I swap it or give one piece its own border?](#how-is-an-equipments-glowing-border-quality-effect-chosen-where-do-i-swap-it-or-give-one-piece-its-own-border)
- [How is the background animation of an equipment detail dialog chosen? Where do I swap it or give one piece its own?](#how-is-the-background-animation-of-an-equipment-detail-dialog-chosen-where-do-i-swap-it-or-give-one-piece-its-own)
- [How are titles unlocked and upgraded? Where do I tune title power / price?](#how-are-titles-unlocked-and-upgraded-where-do-i-tune-title-power--price)
- [How is health regeneration per second calculated? Where do I make it faster or slower?](#how-is-health-regeneration-per-second-calculated-where-do-i-make-it-faster-or-slower)
- [Where does the detail dialog appear when I hover equipment? Why did it used to fall off screen?](#where-does-the-detail-dialog-appear-when-i-hover-equipment-why-did-it-used-to-fall-off-screen)
- [Why does a new character's bag hold a pile of identically named weapons? How do I change the starting list?](#why-does-a-new-characters-bag-hold-a-pile-of-identically-named-weapons-how-do-i-change-the-starting-list)
- [How does the mall work? Where do I add goods or change prices?](#how-does-the-mall-work-where-do-i-add-goods-or-change-prices)

## Preview errors

### Preview reports reading 'width'

If the Cocos Creator preview shows errors like:

- TypeError: Cannot read properties of null (reading 'width')
- Preview Error: [Window] ... reading 'width'

it usually means the Camera / Canvas / Window binding has not finished during the editor preview phase, or something read a null window object while the scene camera or canvas was initializing. This comes from the preview startup process itself, not from the TypeScript logic.

Things worth checking:

- Does the Canvas node exist, and does it have its Camera bound correctly?
- Is the Camera component mounted on a child node of Canvas?
- Does anything read viewport dimensions at scene start before the camera finishes initializing?
- Has the resolution policy been switched between editor Preview and the real runtime?

If you hit this error, confirm the component relationship and initialization order between Camera and Canvas in the scene first, then rerun the preview.

### The map goes black after teleporting and only comes back when I move

The engine's tile map enables "cull tiles by camera viewport" by default (`TiledMap.enableCulling` defaults to `true`), while this project's camera follows the character. The culling range is recomputed **synchronously** by the camera transform event, at which point the camera view matrix has not caught up with this frame's position change — so teleport-like actions (right-click teleport on the minimap / a dash skill / the respawn anchor when entering a map) resolve the visible range to the pre-jump position and the whole target area goes unrendered. The culling is turned off in `GameMap.loadMap` (the engine docs also ask for manual disabling "when a camera is used with a tile map"); this project's maps are only 2 layers of 64×64, so submitting everything costs nothing measurable.

### A new character has no equipment in the bag after a build

`configs/equipments.getBaseEquipments` used to be written as `[...map.values()].filter(...)`. It works in the editor, but **babel compiles with loose mode when bundling** and downlevels `[...iterator]` into `[].concat(iterator)`, and `Array.prototype.concat` only spreads arrays — it does not understand a Map iterator. The result was always a single element `[MapIterator]`, which filtered down to an empty array, leaving the starter bag with only the 5 generic pieces fetched by key via `.get()`. It now collects with `map.forEach`.

**Project convention: converting a Map / Set to an array uses `Array.from(map.values())` or `map.forEach` — never `[...map.values()]` / `[...someSet]`.** The latter breaks only in bundled output (and silently, without an error — it just quietly loses data). To hunt for them: search `client/build/<platform>/assets/main/index.js` for `[].concat(`; any call whose argument is `.values()` / `.keys()` / `.entries()` is a latent bug.

### Clicking a dialog's close button also opens the UI underneath

Input dispatch in the engine runs over **two unrelated channels** (`cocos/2d/event/pointer-event-dispatcher`): the touch channel dispatches only to nodes that registered `TOUCH_*` listeners, the mouse channel only to nodes that registered `MOUSE_*`, and each walks hit-testing top-down by render order and stops at the first hit. This project's buttons are `Button` components (which register only `TOUCH_*` internally), so they are **completely invisible on the mouse channel** — one mouse click therefore gets dispatched twice: `TOUCH_END` closes the dialog, and `MOUSE_UP` keeps traveling down until it finds the minimap's own `MOUSE_UP` listener and opens the minimap dialog again.

The fix is to register UI clickable elements on the mouse channel as well (`utils/input/UiHit.blockClickThrough`): a hit stops propagation, so lower layers never receive that click. It covers every button / toggle / scroll area (`UiHelper.createButton`, `createToggle`, `createScrollView`), dialog panels (`GameUiHelper.createDialogBg`, so clicking blank panel area does not punch through either), draggable nodes (`Draggable`), and the hand-written clickable elements on the bottom bar / hotkey slots / war soul cards.

- Only `MOUSE_UP` is registered (punch-through prevention relies on the engine's "stop at first hit", which has nothing to do with whether the node has a `MOUSE_DOWN` listener), and `MOUSE_MOVE` is **deliberately** not registered: mouse position is what global listeners use (cursor style, direction while dragging), and a node hit would swallow `MOUSE_MOVE`, freezing cursor style and direction whenever the pointer moves onto a button
- Bubbling and parent/child order: the engine's priority sort puts **children ahead of parents** (later draw on top), so a close button still receives its `TOUCH_END`
- Self-check script: `node ../tools/audit-ui-click-through.cjs` — it finds every touch click registration site, back-traces the node source, and reports which ones are covered and which are missed (currently 25/25 fully covered). The back-trace takes the **nearest assignment before the registration line**: the same variable can be assigned several times in one file (for instance `this.recycleButton = null` clears a stale reference before the factory builds it), so taking the "first match" would wrongly report a fine factory product as unregistered — when a tool cries wolf, suspect the tool first; the `REVIEWED` block at the top of `../tools/audit-ui-click-through.cjs` records elements that were reviewed and need no registration, with reasons (the world-side NPC is deliberately not registered: registering would consume `MOUSE_UP` and the global world-click listener would stop receiving it; the NPC is instead handled by `markWorldInteractive` + `LayerManager.isPointOnWorldInteractive` skipping on the **world** side)
- Separately: "clicking UI does not move the character" on the world side relies on another criterion, `LayerManager.isPointOnUi` (a screen-space hit test) — unrelated to node listeners; the two complement each other

### After clicking an NPC and opening a dialog, why does the character keep walking?

Two things stack up:

1. An NPC is neither on the UI layer nor a monster, so the world-side "hold to walk" treats it as empty ground and steps toward it first (this is the "mouse-press move event firing unintentionally");
2. The "first hit owns it" mechanism above consumes this click's `MOUSE_UP`, while world-side hold-to-walk **starts on press and ends on release** (`RolePointerInput` listens to the global `input.MOUSE_UP`). The release never arrives → the pressed state never clears → the character walks forever.

The fix (the "press ownership" section of `ui/utils/input/Pointer.ts`):

- **World-side interactive objects such as NPCs** are marked with `UiHit.markWorldInteractive` (in `MapObjectSpawner` it is set on the **node carrying the click listener**, so the judgement area matches the click area by construction); the world side asks `LayerManager.isPointOnWorldInteractive` before pressing or clicking → no walking (`RolePointerInput`), no clearing of the current attack target, no interrupting auto-battle (`ScreenClickInput`)
- **When the interface owns the release, hand the press end back to the world side** (`releaseWorldPress()`): both `Pointer.bindMousePress` and `UiHit.blockClickThrough` are wired to this hand-back; the world side registers an **idempotent** finish callback via `setWorldPressRelease` at construction (it does nothing when nothing is held, so an unconditional hand-back can never stop walking by mistake)
- While there, the missing half of "which press belongs to whom" was completed on the mouse channel: the **hit UI element is recorded at press time**, and a release is answered only if its start lies inside that element or its subtree (`isUiPressWithin`) — matching the touch channel's semantics where "whoever `TOUCH_START` hit owns the whole gesture" (`claimedTouchIdList`). Benefit: releasing the pointer over the minimap / a button / a dialog panel while holding to walk does **not** trigger that UI element, and the character stops normally
- The start point is registered by **each UI element listening on the mouse channel** (`trackUiPress(node)`, called automatically inside `bindMousePress` / `blockClickThrough`), and it records `event.target` — **not the node itself**: node events **bubble**, so ancestors such as dialog panels and scroll areas receive the same press; but within one dispatch `event.target` has exactly one value (the engine's `dispatchEvent` assigns it once at the start and it does not change during bubbling), so "everyone records their own" writes identical values regardless of order. Recording **the node itself** instead would let ancestors overwrite an inner element's start point with themselves during bubbling → inner elements (bag cells / equipment slots / the map preview image) fail the release match → **every click in a dialog dies at once** (cannot equip or unequip, map dialog clicks do nothing)
- Registration sites must be nodes that **have a `UITransform`**: do not take the shortcut of hanging the start point on the UI root (`LayerManager.UILayer`) — it has no `UITransform`, and registering a mouse event on it makes the engine throw a `cameraPriority` null pointer on every mouse event (see the next FAQ entry). Every registration entry goes through the same guard, `ensureMouseHitTestable`
- The judgement must accept the **subtree**: item icons inside bag cells / equipment slots register `MOUSE_ENTER` (hover detail), so clicking one hits the icon rather than the cell, hence "the start point is me or inside my subtree" (`target.isChildOf(node)`)
- Do not hand-roll `node.on(Node.EventType.MOUSE_UP, ...)`: that owns the release on the interface while nobody hands it back to the world side. Go through `bindMousePress` / `bindPointerAction` / `blockClickThrough`; the self-check script has a dedicated segment watching for this
- **Nodes registering only hover events (`MOUSE_ENTER` / `MOUSE_LEAVE`) count as "having a mouse listener" too**: they are this press's hit target, and if no other registration site exists in their subtree they must call `trackUiPress(node)` themselves (example: the status icons of `StatusIconBar` — neither the status bar nor the character info column is a registration site), otherwise their press is never recorded and the release reads the stale start point of the previous press
- Self-check: `node ../tools/audit-ui-click-through.cjs` now has five segments — (1) is every touch click element registered on the mouse channel; (2) **has every node with a mouse listener become a press-start registration site** (its own `trackUiPress`, or another registration site in its subtree with the reason written down); (3) `blockClickThrough` call sites; (4) does every mouse-channel ownership point use the shared helper; (5) are the **13 critical wirings** of press ownership all present (including a negative check: the UI root must not show up with `trackUiPress` / `Node.EventType.MOUSE_`), and it exits with a non-`0` code if any is missing

### Moving the mouse reports Cannot read properties of null (reading 'cameraPriority')

This is "a mouse event registered on a node without a `UITransform`" — the classic case being the UI root node `LayerManager.UILayer` (`createLayer` only creates an empty `Node`):

- Before every mouse event the engine sorts the listener node list (`pointer-event-dispatcher._sortPointerEventProcessorList`) and caches each node's camera priority: `const trans = node._getUITransformComp(); cachedCameraPriority = trans!.cameraPriority;`
- The outer guard is `if (node._uiProps)`, and `_uiProps` is `new`-ed right in the `Node` constructor (field initialization in `node.ts`), so **it holds for any node**; the inner `trans!` is another non-null assertion (`_sortByPriority` in the same file honestly checks for null) — so a node without a `UITransform` crashes the moment it enters the listener list, and it does so on every mouse event, wrecking all mouse interaction in the preview
- Such nodes could never be hit anyway (`_handleMouseDown` returns `false` directly when it cannot get the component), so registering mouse events on them is pointless — it is simply stepping on a landmine
- Guard: `Pointer.ensureMouseHitTestable(node, api)` checks at every registration entry (`trackUiPress` / `bindMousePress` / `blockClickThrough`); when no `UITransform` can be obtained it skips the registration and `console.warn`s who tried to register
- That is also why the "current press start point" **cannot** hang on the UI root (the previous version did exactly this) and must be registered by **each UI element listening on the mouse channel** (see the FAQ entry above)
- Verification: segment 5 of the audit script carries the negative check "no `trackUiPress` / `Node.EventType.MOUSE_` on the UI root"; the simulation script `press-bubble-sim.cjs` reimplements this engine sort in its segment 0 and reproduces both outcomes directly — "hang it on the UI root → throws", and "same code but through the guard → intercepted, no crash"

### Every feature inside a dialog suddenly stopped responding (cannot equip, cannot unequip, map clicks do nothing)

First check whether press-ownership registration has swung to one of two extremes again:

- Node events (`TOUCH_*` / `MOUSE_*`) all **bubble**: after its hit test, the engine's `_handleMouseDown` sets `event.bubbles = true` and then `dispatchEvent`s it along the ancestor chain to every listener (`getBubblingTargets` walks all the way to the root)
- And `event.target` is **assigned exactly once, at the start of dispatch**; throughout bubbling it stays the originally hit node
- Extreme one: **each element records "itself"** (the first version) → ancestors such as dialog panels and scroll areas **overwrite inner elements' start points with themselves** during bubbling, inner elements fail the release match, and every click inside the dialog dies at once
- Extreme two: **move the start point to the UI root and record it once there** (second version, logically correct) → the UI root has no `UITransform`, and registering a mouse event on it crashes the engine (see the FAQ entry above)
- The correct answer: registration point = a UI element with a `UITransform`, recorded value = `event.target`. Every registration site writes the same value, so order does not matter and the `UITransform` landmine is avoided
- **Full-screen modals (death mask, confirm box) must take part in hit-testing instead**: they must **never** be marked click-through (`markClickThrough`), or the mask might as well not exist — clicks still reach the world; the touch channel also has to register all four `TOUCH_*` itself and stop bubbling, otherwise a press lands on a bag cell below the mask and starts dragging an item straight away (see `components/dialogs/ConfirmDialog`; the "marked click-through" judgement is policed by `node ../tools/audit-ui-click-through.cjs`)
- Chain self-check: segment 2 of `node ../tools/audit-ui-click-through.cjs` lists, one by one, "node with a mouse listener → does it already have a registration site", and segment 5 carries the wirings such as "what is recorded is the dispatch hit target" and "ownership judgement includes the subtree"; on the behaviour side, `press-bubble-sim.cjs` runs one batch of click scenarios across five stages (original / click-through fix / everyone-records-own / UI-root registration / current fix) for comparison

### How do I tune drops?

Drop priority is `drops / dropPicks` on the monster entry > the per-monster table `configs/monsterDrops` > level-based fallback generation in `configs/drop.monsterDrops`.

- To change what one monster drops, how heavily, and how many pieces: edit that key's `entries` (each entry carries `weight`, `chance` and a `count` range) and `picks` in `configs/monsterDrops`. `picks` accepts a number (fixed count) or a `[min, max]` range (for example `[1, 10]` = 1~10 pieces this time; **each pick rolls independently and can hit the same entry again**, duplicates merge their quantities; defaults by tier are normal `[1,3]` / elite `[2,6]` / BOSS `[3,10]`)
- Scattering: `ui/utils/drop/DropScatter.scatterDropPositions` spreads greedily in rings around the drop point at minimum spacing `configs/drop.dropRuntime.scatterMinDistance` (52px, = icon 40 + 12 padding), guaranteeing that **no two drops overlap** (world coordinates carry no extra scale, so a circle here is a circle on screen); more items means more rings (10 items puts the outermost ring at radius ≈ 102)
- Ground drop names: equipment is assembled as "prefix + name + suffix" and **coloured per segment** (prefix and name use the prefix colour, the suffix uses the suffix colour). Segments and colours both come from **`configs/equipments.getEquipmentNameParts`**, the same source the detail dialog uses — the two can never drift apart, and there is no second colour table. Non-equipment stays a single white line, with stackable items getting an extra "x{count}" segment. Geometry (icon size / name font size and line height / segment gap / name and count colours) all lives in `configs/layout/hud.dropItemLayout`; the name row auto-sizes to content width (`Layout` horizontal CONTAINER plus `Overflow.NONE` per segment) and is centred directly under the icon
- Equipment entry criteria: base equipment with "level ≤ monster level, capped at 10 levels below or equal, at most 2 tiers per slot", with all 15 prefix/suffix variants of each piece expanded (`_pPrefixSuffix`, with normal·mortal keeping the base id). Weights decay by prefix/suffix rarity (prefix ×[1, 0.7, 0.45, 0.25, 0.12], suffix ×[1, 0.5, 0.22], slot ×1 / 0.9 / 0.8)
- Hence within the 555 equipment pieces: weapons and clothes are spread across monsters of every level band, while helmets / belts / boots / necklaces / rings currently **only have level 1 starter pieces**, so they appear only in low-level monster (≤11) tables — once higher-level equipment for those slots exists, widen `EQUIP_LEVEL_GAP` and `MAX_TIER_PER_SLOT` and regenerate to cover higher-level monsters
- If a newly added monster forgets its drops, it falls back to the level-based `configs/drop.monsterDrops(level, tier)` route, so you never get "killed it and nothing dropped"

### I want to change a number or a piece of text on screen — which file do I edit?

One overall rule: **core code (`assets/ui`, `assets/skills`, `assets/entities`) only decides "how it runs"; everything tunable lives in `assets/configs`**. Match what you are changing to its home:

| What you want to change | Where it lives |
| --- | --- |
| Values / growth / drops / equipment / monsters / skills / maps | the matching domain config `configs/{growth,drop,equipments,monster,skill,map,…}.ts` |
| Equipment borders (which combination uses which sheet / per-piece override) | `configs/border.ts` (`prefixSuffixBorderData` / `customEquipmentBorderData`; display rules in `configs/layout/borders.ts`) |
| Equipment detail backgrounds (which combination uses which / per-piece override) | `configs/background.ts` (`prefixSuffixDetailBackgroundData` / `customEquipmentDetailBackgroundData`; frame rate in `configs/layout/backgrounds.ts`) |
| Any text a player reads (tips, validation reasons, labels, hover details, loading progress) | `configs/texts.ts` (templates use `{placeholder}`, read them with `getText(key, params)`) |
| Interface position / size / images / font sizes | `configs/layout/{hud,dialogs,panels,scenes}.ts` (barrel: `configs/hudLayout`) |
| What shared parts look like (empty-node debug frame, input placeholder colour, tip colours and durations) | `configs/layout/theme.ts` (`uiTheme`) |
| Collider visualization line width / opacity / colours | `rangeStyle` in `configs/debug.ts` |
| Bottom-bar entries (name / icon / unlock level / hotkey) | `configs/bottomNav.ts` (click callbacks stay in the component, associated by `key`) |
| Character body size and collider, rigid body parameters | `roleBody` / `roleRigid` in `configs/role.ts` |
| Drop pickup radius, bag-full tip throttle, drop scattering distance | `dropRuntime` in `configs/drop.ts` |
| Ground drop names and geometry (icon size / name font size and line height / segment gap / name and count colours) | `dropItemLayout` in `configs/layout/hud.ts` (prefix/suffix text and colours: `equipmentPrefixColors` / `equipmentSuffixColors` in `configs/equipments.ts`) |
| Joystick feel (dead zone / threshold / radius) | `joystickMove` in `configs/role.ts` and `joystickLayout` in `configs/layout/hud.ts` |

- **Reading text**: code writes only keys and parameters, e.g. `GameUiHelper.createTip("soul_bind_gold_tip", { need: 1200 })`; the template sits in `configs/texts.ts` as `"binding ingots insufficient, upgrading needs {need}"`. A missing parameter **keeps the placeholder verbatim** (so missing args are obvious at a glance); an unregistered key returns the key itself and `console.warn`s
- **Validation text is not scattered**: equip / map-entry validation (`GameHelper.getEquipmentRejectReason` / `getMapEnterRejectReason`) produces only a `TextRef` (`{key, params}`), and the tip layer resolves it — so even "why can't I wear this" logic contains no Chinese
- **`configs` does not depend on UI**: configs describe data only; callbacks and branches stay in components (for example `bottomNavItems` carries a `key`, and `BottomBar` connects it with a `Record<key, callback>` table)
- **Self-checks (run these after a change)**:
  - `node ../tools/audit-config-leak.cjs` — reports "tunable values scattered inside ui/" plus the reverse check "every text key referenced in code is registered in `configs/texts`". Development logging (`console.*`) and internal node names do not count as leaks: the former is skipped outright, the latter is recorded in `../tools/config-leak-allowlist.json` with the reason written down
  - `node tools/test-texts.cjs` — text template unit tests (placeholder substitution, missing args kept, unregistered key fallback)
- **Changed a config but nothing happened?** Check whether it is the "config changed but the code keeps its own copy" case: segment 1 of the audit script exists specifically for that, and 0 findings counts as converged

### I want to change the bag "tidy" ordering (ascending / slot order / what comes first)

Carrying and sorting are two separate layers, and it is clear which one you are touching:

- **Carrying** (merge stackables of the same kind → sort → sink empty cells) is the pure function `configs/items.tidyBagGrid(bag)`: takes the bag grid and returns a new grid array, touches neither save data nor UI. It holds two invariants — **row and column counts never change** and **not a single item is lost** (quantity conserved per id); ids that were delisted or cannot be parsed are kept as-is and sorted last (not merged, not split)
- **Tidy = a complete re-layout**: afterwards everything is packed row by row starting from **the first cell (row 0, column 0)**, empty cells sink to the end, and no holes are left in the middle (a dedicated unit test `isPackedPrefix` watches this rule, so do not invent a "tidy that leaves holes")
- **Sorting rules** live in `configs/items.compareBagGoods`: major category (equipment → consumables → materials → other) → inside equipment "level descending → slot → prefix descending → suffix descending" → id as tiebreak (same-kind items always end up adjacent and the result is reproducible). To sort levels ascending, or to put consumables ahead of equipment, change only this one comparison direction
- **Slot order is not written twice**: `configs/equipments.equipmentSlotOrder` is generated directly from the order of the equipment slot config `equipmentSlotData` — changing slot config order updates both the equipment panel layout and bag tidying together
- **Entry point**: the bottom button of the bag dialog → `StorageManager.tidyBag()`, which only does "read character → call the pure function → **persist and refresh only if something changed**" (when it is already tidy it says "the bag is already tidy" and does not rewrite storage)
- **The "clicked tidy and nothing happened" trap**: whether tidying is needed is decided by comparing a **fingerprint before and after, and the fingerprint must count empty cells too**. Otherwise "item order unchanged, just scattered" (say, dragging the potion in cell 3 to cell 8) produces a fingerprint identical to the tidied result → `tidyBag` concludes "already tidy" and returns, and the player sees "clicked it, nothing happened, items did not come back to the first cell". Fix: `bagSignature` concatenates cell by cell with empty cells taking a slot (`·`), and "empty bag" is judged separately via `bagIsEmpty` (the empty string can no longer stand for an empty bag)
- Regression tests: `node tools/test-bag-tidy.cjs` (compile sandbox in `tools/lib/configs-sandbox.cjs`: compiles `configs/items.ts` to CommonJS and replaces the engine with a `cc` shim implementing only `Vec2/Vec3/Size/Color`, so node runs **the real config tables and the real functions**; covers shuffled mixes, full-bag merges, `maxStack` splitting, slot / prefix / suffix order, invalid ids, idempotence)

### I want to tune the bag "recycle" price (too high / too low, or price one item separately)

- **Price is "level curve × prefix/suffix multiplier"**, sourced solely from `configs/growth.equipmentRecyclePriceCurve` (6 piecewise-linear bands, the same kind of curve used for characters and monsters): the base price comes from the equipment's own `level` (about 40,000 at level 60), and prefix/suffix variants further multiply by `equipmentPrefixRates × equipmentSuffixRates` (supreme·divine = base price × 4.2). To move prices globally **change only that curve band**
- **To price one piece separately**: write `recyclePrice` on its entry (it overrides the curve-generated value, the same pattern as "combat attributes are optional"). The base piece and its 14 variants all scale from that base price
- **Currency is bound ingots** (`role.bindGold`, the same wallet war soul upgrades use); the character info column balance refreshes immediately after recycling, and the equipment detail dialog (mouse hover) shows that piece's "recycle price N bound ingots"
- **Only equipment in the bag is recycled**: equipped slots are never touched; consumables / materials / ids that cannot be parsed are left alone entirely, not even their cell references (`configs/items.recycleBagEquipmentGrid` is a pure function holding the invariants "grid dimensions unchanged / non-equipment untouched")
- **Why it takes two clicks**: recycling is irreversible, so the button is a two-step confirm — the first click only reports numbers (piece count + ingots gained) and changes the text to "confirm recycle", the second click actually recycles; a 3-second timeout or closing the dialog resets it (`bagDialogLayout.recycleButton`). This avoids inventing a confirm dialog, and therefore avoids one more node whose punch-through and layering need handling
- Regression tests: `node tools/test-bag-recycle.cjs` (covers: every piece has a price, pricing rules and multipliers, only equipment moves and non-equipment references stay put, empty / full / dirty data edges, idempotence, preview and actual recycle agreeing)

### Can a deleted character be recovered? Why is "start game" dead after deleting one?

- **Once deleted it is gone**: deletion calls the server's `RoleApi.remove` first (local cache is cleared only after it succeeds), and the server really deletes (removes the row from `roles`) — **no recycle bin, no backup**. The `roles` in local `localStorage` is only a cache and is wiped along with it
- **Entry point**: the "manage" button on the left of the character selection screen → a red "delete" button appears above each character slot (with a hint bar on top of the stage explaining how it works) → one click turns it into "confirm delete" → a second click within 3 seconds really deletes. Click "manage" again to leave manage mode
- **The delete button is not parented to the character node**: the character preview binds its own `TOUCH_END` (clicking selects that character), so nesting the delete button under it would **bubble** into "select this character". The button therefore hangs on the stage, its position derived from "slot position + `manageRole.deleteButtonOffset`", and it is rebuilt whenever the list changes
- **Two-step confirm rather than a confirm dialog**: the same rule as bag "recycle" (the first click reports the character name, the button text changes, a 3-second timeout auto-resets, see `roleSelectorLayout.manageRole.confirmTimeout`) — no new nodes, no new mouse listeners, hence no layering or punch-through pitfalls
- **Deleting the currently selected character also resets the selection**: name and level fall back to placeholder text and the "start game" button greys out again (otherwise a selected state that does nothing would be left behind); `selectedRole` in the save is cleared too, **which is mandatory** — a stale selection makes the next `findOnlineRole()` return `undefined` and enters the game stuck at the "loading character" step (`StorageManager.deleteRole` also cleans up selections that already point at nonexistent characters while it is there)
- ⚠️ **Do not confuse "character deleted" with "character kicked offline"**: the former (business code 20002) deletes the local cache along with it; the latter (**20007**) means the character still exists and only the account's online character was cleared from the backend, so **only the online flag may be cleared, never the character**. See [../FAQ.en.md](../FAQ.en.md#an-admin-edits-a-character--when-does-the-player-see-it)
- Regression tests: `node tools/test-role-delete.cjs` (runs **the real `StorageManager`** in a sandbox: `tools/lib/storage-sandbox.cjs` copies `StorageManager.ts` plus the `entities/Role` and `configs` it truly needs, swaps UI-layer imports for stubs, and the `cc` shim additionally provides an in-memory `sys.localStorage`; covers deleting existing / nonexistent / twice / same name different id / down to empty, integrity of remaining characters, persistence taking effect, three selection scenarios, **administrator kick clearing only the online flag and not deleting the character**, plus source-level assertions about wirings such as "is the manage button bound to an event" and "where does the delete button hang")

### How do I discard things from the bag? Can a misclick be undone?

- **Two entry points, two confirm shapes**:
  - **Drag out of the dialog to destroy (recommended)**: hold and drag an item, **release outside the bag dialog** → a full-screen confirm box appears (stating item name and the whole cell's quantity) → "OK" destroys the whole cell, "Cancel" returns the item to its place. While dragged out of bounds the source cell item **stays dimmed** (it is "held"), recovering only after cancel or confirm;
  - **Discard mode**: bottom "discard" → the button becomes "exit discard" → click the cell to discard (the first click only reports the item name and quantity, changing nothing) → a second click **on the same cell** within 3 seconds really discards it. Timeout, clicking another cell, clicking "tidy" / "recycle", or closing the dialog all abandon the pending state
- **Why dragging out of bounds needs a confirm box while clicking a cell only takes two steps**: releasing a drag is a **one-shot action** — there is no button or cell left to "click once more", so a confirm box has to ask; clicking a cell can naturally be repeated, so "click again = confirm" saves nodes and sidesteps layering / punch-through pitfalls (see the two-channel ownership notes in `components/dialogs/ConfirmDialog`)
- **How "cancel" returns it to place**: **the data is never modified during the drag** — the only thing touched is the source cell item's opacity (dimmed while dragging → held dim after leaving), so "return to place" needs no restore step beyond releasing the hold (`BagGridView.releaseDiscardHold`). Destruction requires three conditions together: dragged past the threshold + not released over any cell + released outside the dialog rectangle (using the dialog's own `UITransform.hitTest`, the same criterion the cells use)
- **A discard takes the whole cell**: stackables (consumables / materials) lose the entire stack at once, and there is currently **no "discard only N" quantity picker** — adding it means introducing a quantity input control first, so do not quietly change semantics on the discard path
- **Irreversible**: there is no recycle bin in the local save; discarded items cannot come back (data does sync to the server, but that sync pushes the state *after* deletion, and the server only stores character data without validating contents or keeping history)
- **Not the same as "recycle"**: recycling **takes only equipment** and converts it to bound ingots; discarding **works on equipment / consumables / materials alike and returns nothing**, and exists for clearing junk. Both touch only the bag — equipped slots are unaffected by construction
- **Rules and prompts live in the data layer**: `StorageManager.getBagDiscardPreview` (reports numbers, read-only) and `StorageManager.discardBagGood` (clear that cell → persist → refresh the bag). The interface (`BagDialog`) only routes modes and wires the confirm box: in discard mode clicking a cell discards, otherwise left click still uses and right click still equips
- **The confirm box is a full-screen modal that owns both channels**: on the touch channel the mask registers all four `TOUCH_*` and stops bubbling itself (otherwise a press would pass through the mask onto the bag cell below and start dragging an item directly), and on the mouse channel `blockClickThrough` stops at first hit (neither lower UI nor the world receives that click); the full-screen size comes from the **visible area** (`ScreenLayout.getVisibleSize`, which under NO_BORDER is not the design resolution). Clicking blank mask area does **nothing** — a destructive operation has to be chosen explicitly
- **The confirm box hangs on the UI layer and does not die with the bag dialog**: so closing the bag dialog must explicitly dismiss it (`BagDialog.closeDiscardConfirm`), otherwise a black curtain stays over the screen
- **Text and geometry live in config**: button text `configs/texts.label_bag_discard / label_bag_discard_exit`, confirm box text `bag_discard_confirm_title / bag_discard_confirm_text` and the generic buttons `label_confirm_ok / label_confirm_cancel`, tips under `bag_discard_*_tip`; button position and timeout in `configs/layout/dialogs.bagDialogLayout.discardButton` (the three bottom buttons are offset by 140 each → pairwise spacing 17), confirm box geometry in `configs/layout/dialogs.confirmDialogLayout`
- Regression tests: `node tools/test-bag-discard.cjs` (in a sandbox running **the real `StorageManager`**: discarding equipment / consumables / materials, whole-cell quantities discarded together, only the target cell touched, persistence taking effect, idempotence, only the online character affected, equipment slots untouched, empty-cell and out-of-range defence, unrecognisable ids still cleared, preview being read-only, plus source assertions for the discard mode / drag-out destruction / confirm box wiring, config and text; 117 checks in total)

### How do I drag a bag item into another cell?

- **Gesture**: hold an item in a cell and move; dragging counts only after the displacement exceeds `configs/layout/panels.bagGridLayout.drag.threshold` (default 10 pixels) — releasing inside the threshold stays a "click" (left click uses, right click equips), so a few pixels of trembling does not turn into a drag. On release, the destination follows the **pointer position**: over a cell = move; **outside the dialog** = destroy confirm (see "how do I discard things" above; the source item is held dimmed first); inside the dialog but not over a cell = nothing happens, the item returns to place
- **Drop rules** (pure function `configs/items.moveBagCellGrid`, three cases in order): target is an **empty cell** → move the whole cell over (quantity unchanged); target is a **stackable of the same kind** → merge (whatever exceeds the per-cell cap `maxStack` stays in the source cell); **anything else** (different item, non-stackables such as equipment, ids the config cannot parse) → the two cells swap. Not a single item is lost, and cells other than source and target **do not even change reference**
- **Entry point**: `StorageManager.moveBagGood(from, to)` only does "read character → call the pure function → **persist and refresh only if something really moved**", same rule as "tidy": **no toast** (the feedback of dragging is the item's own position / quantity change), and an invalid drag (empty cell, back onto its own cell, out of range) returns false silently
- **Presentation is all in config**: the ghost icon following the pointer while dragging (size / opacity), the source cell dimming, and the drop highlight frame (size / outline width / inset / colour) all live in `bagGridLayout.drag`; the component writes no numbers
- **Why the touch channel (`TOUCH_START/MOVE/END`) instead of the mouse channel**: in a mouse environment the engine **simulates** `MOUSE_DOWN/MOVE/UP` as `TOUCH_START/MOVE/END` (engine `input._simulateEventTouch`), so one code path serves both environments (dialog dragging via `Draggable` works the same way); the touch channel also carries the semantics "whoever `TOUCH_START` hit owns the entire touch" — no matter where the pointer travels or whom it is released over, the end event goes back to the starting cell and buttons passed along the way cannot steal it. **Conversely you must never listen for `MOUSE_MOVE` on a cell**: it swallows global pointer tracking (cursor style and hold-to-walk direction would both freeze, see "every feature inside a dialog suddenly stopped responding" above)
- **Releasing after a drag does not also use or equip the item**: as soon as a press involved dragging (`BagGridView.pressDragged`), the click callback for that release is intercepted; the flag resets on the **next press**, so nothing depends on which of the drag's `TOUCH_END` and the click's `MOUSE_UP` runs first
- **Right button does not drag items**: `TOUCH_*` events carry no button information, so the mouse channel records one extra fact on `MOUSE_DOWN` (`rightPress`) to preserve "right button = equip"
- **Dragging an item does not drag the whole dialog away**: the dialog background carries a drag component (`components/input/Draggable`, hold the dialog to move it), and touch events **bubble** — a touch on a cell bubbles all the way to the dialog background, so "drag the item" took the window along. The fix keeps touches inside the grid area (`BagGridView.setupTouchOwnership`: all four `TOUCH_*` set `propagationStopped = true`) — pressing a **cell with an item** lets the cell own the touch first and bubbling stops at the grid container; pressing an **empty cell or grid blank space** has no deeper node claiming it, so the grid container owns the touch itself — in both cases the press never reaches the dialog. `Draggable` carries one generic safeguard on top: when the press point **has its own drag gesture** (registered `TOUCH_MOVE`), the dialog does not take that drag, so adding a scroll view or slider inside a dialog later will not reintroduce the same trap
- **Pending state resets whenever the bag changes**: dropping an item refreshes the bag, and `BagDialog.refresh` clears the pending "confirm recycle", "the cell waiting to be discarded", and "the item held by dragging out of the dialog" along the way — otherwise dragging away or swapping the target cell's contents would make the second click (or second confirmation) hit the wrong thing
- **Old saves and bag size**: loading aligns to `bagRow × bagCol` in `StorageManager.ensureRoleDefaults` (`configs/items.normalizeBagGrid`) — pad or trim when the size differs, avoiding "items laid out into cells the interface does not have", which looks exactly like losing things
- Regression tests: `node tools/test-bag-drag.cjs` (move / merge / overflow / swap / unrecognisable id / invalid drag, `normalizeBagGrid` size alignment, `StorageManager.moveBagGood` persistence and online-character-only behaviour, plus source assertions for the drag wiring)

### How is an equipment's glowing border (quality effect) chosen? Where do I swap it or give one piece its own border?

- **Where it shows**: on item icons in bag cells and equipped slots (the single mount point is `GameUiHelper.createGood`, shared by both entries). The border is an atlas under `resources/borders` (plist + same-named png, 8~12 frames) looped whole, mounted on the **icon node** — dimming the icon while dragging dims the border with it, and refreshing a cell destroys the icon and the border along with it
- **Which prefix/suffix uses which sheet**: `prefixSuffixBorderData` in `configs/border` — 5 prefixes × 3 suffixes = 15 combinations each get one sheet, taking the **first 15** in ascending power order (sfx_30123_0 ~ sfx_30137_0, first banded by suffix into mortal / celestial / divine, then increasing by prefix inside each band). Change only this table to swap them
- **Per-piece override**: `customEquipmentBorderData` in the same file, which **takes priority** over the prefix/suffix table — writing a variant id (`weapon_20_p4s2`) affects only that one variant, writing a base piece key (`weapon_20`) affects **every** variant; the remaining 69 sheets are kept free for it (see `tools/border-preview.png` for what the art looks like; a yellow frame marks the 15 already assigned)
- **All 84 sheets are registered in the system** (`configs/border.borderResources`, guarded by a unit test comparing them against disk one by one); only 15 are assigned so far
- **Size**: the 84 sheets belong to 6 source size families (91×104 / 200×200 / 80×80 / 98×92 / 89×88), uniformly inset into `configs/layout/borders.equipmentBorderLayout.size` (default 56×56 = cell 50 + 3 overflow on each side) with **contain** (each keeps its own aspect ratio); frame rate is tuned in the same place
- **Preloading**: before entering a map, `PreloadManager` loads every atlas used by the prefix/suffix table (`configs/border.getAssignedBorders`), so the first time you open the bag the borders are already there rather than a beat late
- **An engine pitfall (why the border sprite uses `trim = true`)**: this batch of atlases is **uncropped but every frame's offset is non-`0`**, and offset only takes effect in the reverse-padding path used when `trim = false` — the engine then translates the whole frame image away by it (pushing the border out of the cell entirely); with `trim = true` the image takes the full-frame rect and ignores offset completely, and since an uncropped asset's rect equals its original size, it fills the node box exactly without distortion. A unit test guards the premise "every frame's rect == original size", so if a genuinely **cropped** border asset is added later, remember to render that one with `trim = false`
- Regression tests: `node tools/test-equipment-border.cjs` (resource table matches disk, all 15 combinations covered and using the first 15 sheets, every priority branch, spot checks against the real equipment tables, frame index / uncropped guards, interface wiring source assertions; 46 checks in total)

### How is the background animation of an equipment detail dialog chosen? Where do I swap it or give one piece its own?

- **Where it shows**: on the item detail dialog **itself** (the single mount point is `GameUiHelper.createGoodDetailDialog`, shared by bag cell and equipped slot hover). The background is a frame-sequence directory under `resources/backgrounds` (6~20 frames of png per directory) looped whole, and it **directly swaps the dialog node's `spriteFrame`** — it is not a child node (the dialog is a `Layout` container; a background child would join the layout as a row and stretch the container) and it does not cover only part of the panel; it auto-sizes with the dialog and fills the whole panel. A static placeholder image shows until loading finishes; non-equipment and equipment without an assigned background keep the static image
- **Which prefix/suffix uses which**: `prefixSuffixDetailBackgroundData` in `configs/background` — 5 prefixes × 3 suffixes = 15 combinations each get one, taking the **first 15** in ascending power order (sfx_16000 ~ sfx_16014, first banded by suffix into mortal / celestial / divine, then increasing by prefix inside each band). Change only this table to swap them
- **Per-piece override**: `customEquipmentDetailBackgroundData` in the same file, which **takes priority** over the prefix/suffix table — writing a variant id (`weapon_20_p4s2`) affects only that one variant, writing a base piece key (`weapon_20`) affects **every** variant; the remaining 26 backgrounds are kept free for it
- **All 41 background directories are registered in the system** (`configs/background.detailBackgroundResources`, guarded by a unit test comparing them against disk directories one by one); only 15 are assigned so far
- **Frame rate** lives in `configs/layout/backgrounds.equipmentDetailBackgroundLayout` (default 10 frames/second, the same band as borders); the background auto-fills with the panel and has no independent size config
- **Preloading**: before entering a map, `PreloadManager` loads every background directory used by the prefix/suffix table (`configs/background.getAssignedDetailBackgrounds`), so the first hover already has its animation rather than a beat late
- **An engine pitfall (why the background sprite uses `trim = false`, the exact opposite of borders)**: these background frames are imported with auto-trim (**really cropped with non-`0` offsets**), and with `trim = false` the engine pastes the cropped content back onto the original canvas using the offset — every frame's canvas agrees (a unit test guards "meta original canvas == PNG size") so the picture does not jump between frames; switching to `trim = true` would draw each frame's own crop rectangle stretched to the panel, and since crop ranges differ per frame the picture would jitter. This is the opposite conclusion from borders (uncropped assets need `trim = true`) — do not copy one to the other
- Regression tests: `node tools/test-equipment-detail-background.cjs` (resource table matches disk, all 15 combinations covered and using the first 15, every priority branch, spot checks against the real equipment tables, frame index / frame size / canvas guards, interface wiring source assertions)

### How are titles unlocked and upgraded? Where do I tune title power / price?

- **Entry point**: the "title" button at the bottom right of the character info dialog (the only entry, **there is no NPC route**); the title upgrade dialog mirrors the war soul dialog (level list on the left / nameplate animation and info in the middle / attributes plus bound ingots and the upgrade button on the right), minus the "show outwardly" checkbox
- **Display**: once a title is unlocked (raised to rank 1) its nameplate animation shows **persistently** above the character's head, parented to the **head info column container** (the same `FlexCol` holding the character name and health bar, see `RoleDisplay.updateTitleShow`): position comes from that container's vertical layout automatically (inserted topmost = above the name), with no manual positioning and **no scaling** in code (shown at the asset's original size); insertion index and placeholder size are in `configs/layout/hud.roleShowLayout.title` (`siblingIndex` / `size`). The nameplate replaced the "- War God * Valkyrie -" text placeholder previously hardcoded in the head info column; nothing shows while no title is active
- **Data**: `configs/title.ts` — 34 frame directories (all of `resources/titles` registered) ordered 1~34 by power: sfx_13009~13020 the jianghu line (factor 1) → 13031~13041 the military-rank line (1.15) → 13060~13070 the joke "I can fight" line (1.3); names match the text burnt into each asset frame
- **Attribute curve**: the same approach as war souls — each rank maps to an "equivalent character level", takes base attributes and applies `titleGrowth.rate` (0.3, weaker than war souls' 0.5) times the line's factor; changing the level curve in `configs/growth` moves title power automatically with it
- **Price curve**: upgrading to rank N costs `titleGrowth.priceBase` (200) × N² bound ingots (war souls are 300 × N², see `titleUpgradePrice`); to move the whole price up or down change only these two numbers
- **Save data**: old saves missing the `title` field are filled with 0 automatically (`StorageManager.ensureRoleDefaults`); upgrades go through `StorageManager.upgradeTitle`, attributes and combat power recompute immediately, and the overhead nameplate refreshes along with it
- **Preloading**: before entering a map, `PreloadManager` also preloads **the current title's** frame directory (skipped when inactive), so the nameplate is present right on entering the map
- Regression tests: `node tools/test-title.cjs` (level sequence against disk, attribute and price curves recomputed rank by rank, asset guards, wiring assertions and "the placeholder text title has been removed")

### How is health regeneration per second calculated? Where do I make it faster or slower?

Regeneration is **an ordinary attribute** (`hpRecover`, unit "points/second") sitting on the character alongside max health, summed from five sources by `GameHelper.combatCalc` (which is also the single exit for attribute aggregation):

- **Strength is derived as a share of max health**: base regeneration per level = max health × `configs/growth.attributeRange.hpRecoverRate` (default `0.01` = 1% per second). **To retune global speed, change only this one number** — regeneration from equipment / war soul / title / rank is each computed with its own discount and scales proportionally.
- **Only defensive-slot equipment adds regeneration**: the `recover` column of `configs/growth.equipmentSlotShare` (clothes 40 / helmet 20 / belt 20 / boots 20, totalling 100; weapons and jewellery are 0). Wearing all four defensive slots is worth about `equipmentGrowth.setPowerRate` (2) times base regeneration. A "minimum 1 point" is **deliberately absent**: low-level armour adds only a few dozen health, so not reaching 1 point/second is normal; forcing a floor would hand a level 1 character in four pieces of armour 4 points/second for free (same-level monsters deal about 7 points/second), making the early game invincible.
- **War soul / title / rank**: use the same algorithm as their other attributes (`rate × line/band factor`), so regeneration rises and falls together with max health.
- **Settlement**: `ui/utils/battle/HpHelper.recover`, ticked **once per second** by the game main loop (sharing one timer and one save with mana regeneration, so it does not cause extra writes); fractions below 1 point accumulate in `hpRecoverAccumulator` instead of being lost (no rounding loss at low regeneration rates); recovery is capped at max health.
- **No regeneration while dead**: settlement is skipped outright when `hp ≤ 0`, otherwise it would pull the character back out of the death flow (death animation + respawn dialog).
- **Not counted in combat power**: the weight table in `configs/battle.combatCalc` explicitly excludes `hpRecover`. Regeneration changes neither output nor the ceiling on damage taken, so including it would only inflate combat power thresholds on every map. **Monsters do not regenerate either** (`configs/growth.monsterStats` always returns 0).
- **Old saves**: missing fields are filled with 0 when a character is loaded, via `StorageManager.ensureRoleDefaults → HpHelper.ensureDefaults` (full health falls back to max health); no migration script needed.
- **Display**: the "base attributes" list in the equipment detail and character info dialogs renders according to `configs/good.goodShowAttributes` (which slots list this entry) and `goodShowAttributesLabel` (label text "regeneration per second" as well as list order); no attribute table is hardcoded in interface code.
- Regression tests: `node tools/test-hp-recover.cjs` (level curve recomputed level by level, equipment regeneration only on defensive slots with weights totalling 100, monotonicity across the three growth lines, display rules, real `HpHelper` behaviour — full health / dead / cap / remainder / old-save backfill, plus numeric-magnitude probes and source assertions for every wiring)

### Where does the detail dialog appear when I hover equipment? Why did it used to fall off screen?

- **Placement rule** (pure function `ui/utils/layout/ScreenLayout.getPopupPosition`, positioned in `GameUiHelper.createGoodDetailDialog`): vertically **same height and centred** with the item; horizontally on the side of the item **closest to the middle of the screen** (item in the left half → place to its right, right half → to its left), switching sides only when that one would overflow the visible area, and taking the roomier side when neither fits; finally **clamped whole into the visible area** (leaving `placement.screenMargin` on all four sides). When the dialog is larger than the visible area itself (an extremely narrow window) it falls back to centred on screen rather than being pushed off it
- **Why**: the detail dialog (240 wide, 400+ tall after auto-sizing) is far larger than an item cell (50×50), so placing it flush against the item toward the outside of the screen cuts half of it off — what a player wants is "keep the dialog near the middle so the equipment info stays fully visible", hence the rule "as close to the item as possible + always fully visible"
- **To tune the feel**: change `gap` (space between dialog edge and item cell) and `screenMargin` (space between dialog and visible-area edge) in `configs/layout/dialogs.goodDetailLayout.placement`; the component writes no numbers
- **Height is auto-sized**: the dialog is stretched by its own `Layout` (`ResizeMode.CONTAINER`), so the first frame measures the placeholder height from config (200); once content settles it is re-clamped against the **final size** (listening to `SIZE_CHANGED`, idempotent, so it stops moving once content is stable)
- **Why it used to be "badly offset"**: the old implementation took the camera `worldToScreen` **physical pixel** coordinates and subtracted half the **design resolution** — two systems off by a view scale factor (the larger the window the worse the offset, and on high-texture-resolution screens it flew clean off screen); it also switched the dialog's and two child nodes' anchors to 0 / 1 midway, so `Layout` re-laid the content against the new anchors and everything shifted again. Everything now uses **screen-centre coordinates** (`item cell world position − LayerManager.UILayer world position`, the same system as the persistent HUD such as the character column and minimap) and positions by config, with anchors fixed at 0.5/0.5 — **do not** go back to positioning UI with `worldToScreen`
- Regression tests: `node tools/test-good-detail-placement.cjs` (dialog fully visible across 4 window sizes × 100 anchor points, prefers the side toward the middle, does not cover the item when there is room, oversized dialog centred with no NaN, visible area derived as "window pixels ÷ scale", pure function does not mutate its input, plus source assertions for the wiring and for "the old bug must not come back"; 39 checks in total)

### Why does a new character's bag hold a pile of identically named weapons? How do I change the starting list?

Starting items come entirely from `configs/role.getNewRoleEquipments`, handed out in this order:

1. **5 generic pieces**: ring / necklace / boots / helmet / belt (the `*_1` entry of each table);
2. **every base weapon (20 pieces) + every base garment (12 pieces)**: that is, the "normal·mortal" entry of each table (`getBaseEquipments`);
3. **the remaining prefix/suffix variants of weapons at a chosen level**: controlled by `configs/role.newRoleVariantWeaponLevel` (default `1`, set `0` to disable). Level 1 has only one weapon, `weapon_1`, so all 15 of its quality variants (normal·mortal → supreme·divine) go into the bag together — from birth you can compare the **appearance and borders** of different prefixes and suffixes side by side.

So a new character starts with `5 + 20 + 12 + 14 = 51` pieces, and that pile of identically named weapons is those 15 qualities of the same level 1 weapon.

- **To hand out other levels or other slots as a set**: change the level in `newRoleVariantWeaponLevel`, or add one more line like `getEquipmentsByLevel(clothes, level)` inside the function (`configs/equipments.getEquipmentsByLevel` is the generic query that returns every variant at a level).
- **Capacity ceiling**: the bag has only `bagRow × bagCol = 7 × 11 = 77` cells. Anything beyond that is **truncated and dropped** by the `entities/Role` constructor with a `[role] N starter items exceed bag capacity 77 cells…` warning — seeing that log means it is time to trim the list or enlarge `configs/role.bagRow / bagCol` (which are also the source of the bag interface's cell count).
- Regression tests: `node tools/test-new-role-bag.cjs` (all 15 variants present and unduplicated, every list item parseable by the item registry, capacity not exceeded, existing base pieces still handed out, bag structure not shared between two characters, source wiring assertions; 32 checks in total)

### How does the mall work? Where do I add goods or change prices?

- **Entry point**: "mall" in the bottom function bar (hotkey `M`, unlocked at level 1). The dialog body is the mall storefront background (`resources/mall/bg`), with the goods list placed inside the shop-window opening
- **Goods**: **all equipment in the game** — the seven equipment slot tables are pulled in wholesale (`configs/mall.getMallGoods`), including prefix/suffix quality variants (37 base pieces × 15 variants = 555), ordered by "slot order → level → prefix → suffix". Equipment added later is **listed automatically** with no mall change needed
- **Price**: by default everything costs **1 bound ingot per piece** (`configs/mall.mallPrice`). To price one piece separately, add `{ id, price }` to `customPriceData` in `configs/mall` (a variant id affects only that piece, and a base piece key affects only that one entry — matching is by exact id); everything outside that table takes the flat price
- **Purchasing**: click "buy" at the row end → deduct bound ingots → equipment goes straight into the bag's first empty cell (equipment does not stack, so each purchase is 1 piece taking 1 cell). **All three failure modes change nothing**: insufficient bound ingots, bag full (exits as-is), or a goods id the config cannot parse (delisted). Consecutive purchases are unlimited — as long as the ingots hold out, each click completes
- **Why the list scrolls smoothly (virtualization)**: keeping all 555 goods permanently rendered means thousands of nodes taking part in drawing and hit testing, and scrolling stutters; so row nodes are created once, positioned manually (fixed row pitch), and only the few rows near the viewport are **activated** according to scroll position (`MallDialog.updateVirtualRows`). Row pitch follows row height / spacing automatically after a change — do not write another copy of the pitch in the component
- **Hover for details**: parking the mouse on an icon opens the full equipment detail (the same parts as a bag cell: three-segment coloured name, attributes, recycle price, quality background animation) and closes on move-away; details also close automatically while the list scrolls
- **Text and geometry**: buy button / price tag / tips in `configs/texts` (`mall_*` / `label_mall_buy`); dialog size, list and row geometry in `configs/layout/dialogs.mallDialogLayout` (tuned against the shop-window opening of the background image — change the background and retune together)
- Regression tests: `node tools/test-mall.cjs` (goods table equals every piece of equipment in the item registry with no duplicates, stable ordering, flat 1 bound ingot, real `StorageManager` running the purchase chain: debit and bag insert / consecutive buys / insufficient balance / bag full with no debit / non-equipment and broken ids rejected / persistence visible, plus bottom-bar entry wiring and config source assertions; 67 checks in total)

## Networking and save data

### How is character progress synced to the server?

- **Exactly one trigger**: the single exit for persisting a character is `StorageManager.updateOnlineRole`, and levelling from kills / picking up drops / trading / changing equipment / using consumables all pass through it — so syncing hangs here too, and there is **no need** to write another save request inside each gameplay system
- **Debouncing is mandatory**: one fight triggers several consecutive persists, and requesting on each one would hammer the server. `ui/utils/net/RoleSync` remembers only "the last copy of the data" and pushes once after activity stops for `configs/network.roleSyncDelay` (default 1500ms)
- **Scene switches need an extra push**: changes sitting inside the debounce window are lost along with the scene if a map switch happens (the Game scene is rebuilt), so `Game.onDestroy` calls `RoleSync.flush()` explicitly
- **Failures neither block nor spam**: sync requests run in **silent mode** (`silent`), so a failure raises no generic toast; `RoleSync` prompts only on the **first of a run of consecutive failures** (if the backend is down you do not get a popup every 1.5 seconds while fighting). The local save is already written, so the next change or the next game session pushes again
- **Server rejections** each have their own handling (revision conflict 20006 / character deleted 20002 / kicked offline 20007), covered in [../FAQ.en.md](../FAQ.en.md#an-admin-edits-a-character--when-does-the-player-see-it)
- Regression tests: `node tools/test-client-net.cjs` (envelope unwrap / business codes and text / retry and no-retry / token injection / silent and re-login / debounce and flush / dirty session data / every wiring)

### Why can't I see error toasts on the login and character selection screens?

- **Cause**: floating tips (including server text such as "wrong account or password") were mounted on `LayerManager.UILayer` unconditionally. But that layer container is created **inside the game scene** by `LayerManager.initLayer`, and the login / character selection scenes never call it — so the tips were hung on a **static node outside the scene tree**, rendering nothing and following nothing, and the player saw no message at all
- **How it works now**: `GameUiHelper.mountFloatingTip` picks the mount point by "is the container in the current scene" — inside the game it still goes on the UI layer (keeping the temporary layer on top and out of the dialog raise-on-click ordering), while scenes such as login / character selection mount to the **current scene root** (default layer values, matching the scene camera's visibility). The test is not "which scene is this", so new scenes do not mean revisiting this code
- **Do not go back**: do not build tips in business code via `LayerManager.addToUILayer(tip)` — that is only visible in the game again. Go through `GameUiHelper.createTip / createErrorTip` (fixed text, keys in `configs/texts`) and `createTipText / createErrorTipText` (dynamic text such as a server message)
- Regression tests: `node tools/test-dialog-top.cjs` (includes assertions for this mounting rule) and `node tools/test-client-net.cjs`

## Unit test mechanism

### How do unit tests run real Cocos code in node?

Because the core logic **does not depend on the engine**, real code can run in node instead of a reimplementation. There are four sandboxes under `tools/lib/`:

| Sandbox | What it does |
| --- | --- |
| `configs-sandbox.cjs` | Compiles `configs/items.ts` (together with the equipments / drug / material / growth / role / types it depends on) to CommonJS, then replaces the engine with a `cc` shim implementing only `Vec2` / `Vec3` / `Size` / `Color` — config tables use just those four pure data classes and no engine behaviour |
| `storage-sandbox.cjs` | Copies **the real `StorageManager`** (with the `entities/Role` and configs it truly needs), swapping only UI-layer imports for stubs; the `cc` shim additionally provides an in-memory `sys.localStorage` |
| `layer-sandbox.cjs` | Copies **the real `LayerManager`** with a set of `Node` shims carrying engine semantics (parent/child, sibling order, event bubbling) |
| `net-sandbox.cjs` | Copies **the real request layer** (`HttpClient` / `RoleSync` / `ApiCodes`…), with `XMLHttpRequest` injected by the test itself |

Usage:

```bash
node tools/test-bag-tidy.cjs            # build output lands in a temp sandbox under os.tmpdir()
TSC=/path/to/tsc node tools/test-bag-tidy.cjs   # specify tsc manually
```

`PROJECT_ROOT` in `configs-sandbox.cjs` is `__dirname/../..` (this directory, `client/`),
so the sandbox sees `client/assets/**` and `client/temp/declarations/cc.d.ts`.

A few conventions:

- A sandbox rewrites only **imports pointing at the UI layer**; business logic is untouched — tests run real code
- Changing `StorageManager`'s imports means updating the stub list in `storage-sandbox.cjs` in the same commit, otherwise the several suites using it fail together
- In tests you **cannot compare object identity** (`StorageManager.getItem` returns a copy); compare contents
- Assertions check not only "what should happen happened" but also "what should not happen did not" (for example, "`deleteRole` must not appear in the kicked-offline handler")

## Related documents

- [README.en.md](README.en.md) — client overview, opening the project, tool list, typecheck
- [../FAQ.en.md](../FAQ.en.md) — cross-side mechanics (single source of truth for addresses, contract pipeline, three-side interaction, environment gotchas)
- [../server/FAQ.md](../server/FAQ.md) — the server (startup, data model, permissions, throttling and audit)
- [../admin/FAQ.en.md](../admin/FAQ.en.md) — the admin console (page usage, permission-driven visibility)
