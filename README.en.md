# olua

> [简体中文](README.md) | English

**A 2D role-playing game you can play right in the browser.** Create a character, explore maps, fight monsters,
loot equipment, level up, join a guild — the whole loop works end to end; this is not a tech demo.
The project is **free and open source**; deploy your own copy. The live game servers are currently paused —
only the website stays up.

| What you want | Where to go |
| --- | --- |
| Gameplay, screenshots and the full illustrated tutorial | <https://yimw.cn> (official site) |
| Run your own copy | "Run your own copy" below — two Docker commands |

> The live game and admin servers are **temporarily offline** (only the website remains). To play, spin up your own
> copy with the steps below.

> Code lives on [GitHub](https://github.com/WebCoderT/olua); [Gitee](https://gitee.com/putiwan/olua) is a read-only mirror.
> If you find it interesting, a **Star ⭐** is appreciated.

## What kind of game is this

A top-down 2D world in the style of classic oriental MMORPGs: keyboard to move, mouse to fight.
The tedious parts of the genre are deliberately gone — no crafting trees, no pay walls, no forced grouping.

You create a character, spawn in the starter map, and a 6-step tutorial teaches you to walk, fight, loot and open
your bag. A 28-step main storyline then walks you through map after map — or go wherever you like:

- **Get stronger**: kill monsters for experience; leveling refills your bars and unlocks harder maps. Every main-story
  step pays experience and bound currency. Equipment drops from monsters, or buy it outright in the mall.
- **Look better**: every piece of equipment rolls a prefix and a suffix. The same sword becomes a different quality
  item — with a glowing frame on its bag slot and an animated background in its detail panel.
- **Collect**: three growth tracks — Soul (37 ranks), Title (34 ranks), Military Rank (100 ranks) — each adds stats
  and shows above your character.
- **Be social**: you see other players on the same map; add friends, block trolls, report abuse, found a guild,
  recruit members, post announcements, team up and split experience.
- **Take it easy**: auto-battle with pathfinding — click a monster and your character walks over and fights.
  The bag has one-click sorting and one-click recycling.

Death is cheap: revive where you fell, or teleport back to town at full health.

## What it looks like

All screenshots are from a real local deployment. The full illustrated tutorial (including every admin page)
lives on the website: <https://yimw.cn/tutorial.html>.

<p align="center">
  <img src="website/assets/img/登录.jpg" width="32%" alt="Login: account, password, server select" />
  <img src="website/assets/img/选择区服.jpg" width="32%" alt="Server select" />
  <img src="website/assets/img/创建角色.jpg" width="32%" alt="Create character: warrior, mage, taoist" />
</p>
<p align="center">
  <img src="website/assets/img/角色选择.jpg" width="32%" alt="Character select" />
  <img src="website/assets/img/新手村.jpg" width="32%" alt="Starter village: NPCs, monsters and HUD" />
  <img src="website/assets/img/背包.jpg" width="32%" alt="Bag: item grid, sort and recycle" />
</p>
<p align="center">
  <img src="website/assets/img/物品掉落.jpg" width="32%" alt="Loot beams on the ground" />
  <img src="website/assets/img/战魂.jpg" width="32%" alt="War soul: 37 tiers" />
  <img src="website/assets/img/商城.jpg" width="32%" alt="Mall: equipment and items" />
</p>

The admin console (browser-based, for operators editing game data):

<p align="center">
  <img src="website/assets/img/admin/01-overview.jpg" width="32%" alt="Admin overview: accounts, characters, online trend" />
  <img src="website/assets/img/admin/16-equip-align.jpg" width="32%" alt="Admin equipment alignment: positioning sprites" />
  <img src="website/assets/img/admin/26-maps.jpg" width="32%" alt="Admin map editor: NPCs, spawn areas and collision boxes" />
</p>

## What you can play

### Accounts and characters

- Register, log in, pick a server; up to 3 characters per account across warrior / mage / taoist, all data stored server-side — switch computers
  and continue where you left off.
- Progress auto-saves as you play, with an extra save on map change and logout.
- Deleting a character takes two confirmations, so no accidental losses.

### Maps and exploration

- 62 maps, each with its own level and combat-power gate; the teleporter tells you exactly what you're short of.
- Every map has a revive point; entering and teleporting always start there.
- The minimap follows you with red dots for real monster positions; click to enlarge, left-click for auto-pathing,
  right-click to teleport.
- Walking routes around trees and walls — you never get stuck on obstacles.

### Quests

- A 28-step main storyline: take quests from NPCs, read the story as you go, clear the kill objectives and turn in
  for experience and bound currency.
- Steps chain strictly one after another with level gates — following the storyline walks you through the early
  maps and systems.

### Combat

- 220 monster species spread across the 62 maps, roaming in packs by species; drops differ between them.
- WASD to move, left-click to walk, right-click to run, click a monster to attack; an on-screen joystick works in
  mobile browsers too.
- Skills have cooldowns and mana costs, with effects and floating numbers; monsters have skills of their own.
- Damage is computed by the server, so everyone sees the same health bars — no "died on my screen, alive on yours".
- On death the screen freezes; revive in place or return to town at full health.

### Growth

- Experience from kills; higher level means stronger stats. Monsters too far below you give nothing, so no
  farming newbie maps forever.
- Soul (37), Title (34), Rank (100): three tracks upgraded with in-game currency, all counted into combat power.
- Combat power is one number — and also the gate to advanced maps.

### Equipment and items

- Equipment has slots and level requirements; equipping recalculates stats instantly, and your appearance changes
  (all 8 directions).
- Prefix + suffix combos create quality tiers; bag frames and detail-panel backgrounds play different animations.
- Monsters drop equipment: glowing beams appear on the ground — the higher the quality, the brighter — walk over
  to pick up.
- The bag sorts, drags, recycles into currency with one click, or destroys unwanted stacks; toggles for auto-recycle
  (a full bag frees space then re-picks), auto-use and auto-equip make idle play easier.
- The mall auto-lists every equipment variant, browsable by page; 20 fashion outfits change looks but not stats.

### Social

- Player names are colored by relationship: friends green, teammates gold, guildmates blue, enemies red, blocked gray.
- Friendship requires mutual consent; enmity is one-way and the other side is never notified.
- Guilds: create, apply, approve, kick, transfer, disband; the leader edits the guild announcement.
- Teams form on invite, the leader is the only writer, and quitting hands leadership over automatically;
  teammates on the same map share experience.
- Leaderboards for level, combat power and kills — you stay ranked even offline.
- Achievements grant rewards on completion; if your bag is full, the reward goes to your in-game mail.

### Interface

- Health orb, mana orb, experience bar, hotkey bar and minimap all fit on one screen.
- Overlapping dialogs: click one and it floats to the top.
- Hover a skill or status icon for its description and remaining time.
- A 6-step beginner tutorial highlights without blocking input.

## Run your own copy

### Easiest: any server with Docker

```bash
git clone https://github.com/WebCoderT/olua.git && cd olua
cp server/.env.example server/.env      # at minimum set JWT_SECRET and ADMIN_REGISTER_CODE
docker compose up -d --build
```

This starts four containers — site, admin, API and realtime — exposing only port 80.
The web game client is **not started by default** (`profiles: ["game"]`, #1314); to deploy it, run
`bash .workbuddy/skills/olua-deploy/scripts/deploy.sh --game` (see [`docs/deploy.md`](docs/deploy.md) §9).
Domains, HTTPS, backups, upgrades and rollbacks are covered in [`docs/deploy.md`](docs/deploy.md).

### Local development: three commands

```bash
cd server && npm install && cp .env.example .env && npm run dev   # API on :3100
cd admin  && npm install && cp .env.example .env.development && npm run dev   # console on :5173
# open the client/ directory with Cocos Creator 3.8.7 and hit preview
```

Once the server is up, <http://localhost:3100/api-docs> lists every API; the first admin account registered
becomes the super admin.

> The game assets (2.4 GB) are not in the repository — download them per the "Assets" section at the end of this
> file before opening the Cocos project.

## How this project was written

**Every line of code was written by AI.** The human only does three things: request features, look at the result,
and say "not good enough".

So besides the game itself, this repository is a field record of "can AI write a complete project on its own":
how requirements were broken down, how AI mistakes were corrected, and where a human had to make the call —
all preserved in the commit history and `docs/`.

Technically it looks like any open-source game project: Cocos Creator client, NestJS server, React admin,
SQLite database. The difference is that **none of it was typed by a human**.

## For developers

The repository splits into three peer directories, each with its own README and FAQ:

| Side | What it is | Built with | Directory |
| --- | --- | --- | --- |
| Client | the game players play | Cocos Creator 3.8.7 + TypeScript | [`client/`](client/) · [README](client/README.en.md) |
| Server | saves, combat resolution, all APIs | NestJS + SQLite | [`server/`](server/) · [README](server/README.en.md) |
| Admin | operator console for editing data | React + Vite + Tailwind | [`admin/`](admin/) · [README](admin/README.en.md) |

Two rules worth knowing first:

1. **The server decides.** Health, damage, drops and bags on the client are display only; the data of record lives
   on the server, and the client never invents its own numbers when disconnected.
2. **APIs are written once.** Endpoint definitions live on the server; the client and admin API files are generated
   from them, so a missed field change fails the build instead of shipping an `undefined`.

Common commands (from the repository root, `make help` lists all):

```bash
make install        # install dependencies
make dev            # start server and admin console together
make check          # type checks + cross-cutting audits
make test           # client unit tests + server end-to-end tests
make verify         # run this before committing: all of the above + builds
```

Further reading:

| Document | Content |
| --- | --- |
| [`docs/`](docs/README.md) | 40 code documents: every chain traced from database to screen |
| [`FAQ.md`](FAQ.md) | Why things are designed this way, and the pitfalls already stepped in |
| [`website/`](website/index.html) | Site: gameplay details, architecture, engineering, design trade-offs |

## License

[MIT](LICENSE): fork it, modify it, distribute it, use it commercially — just keep the copyright notice.
Everything commercial deployment requires (ops, scaling, compliance, support) is on you; the author provides
no free technical support. Issues are welcome, with no response-time guarantee.

## Assets

Game assets total 2.4 GB and are **intentionally kept out of the repository**. The former
"manifest + GitHub Release volumes" distribution channel has been retired (asset packs are kept
by the maintainers; there is no public download source anymore). The manifest `resources.manifest.json`
and the sync script `client/tools/resources_sync.py` remain in the repo, for local verification and
packing only:

```bash
python3 client/tools/resources_sync.py verify   # check local assets against the manifest
```

## Contact

![QQ group](website/assets/img/QQ群.jpg)
