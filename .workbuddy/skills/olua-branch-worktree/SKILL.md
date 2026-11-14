---
name: olua-branch-worktree
description: olua 仓库多会话并行的**强制工作法**：只要本仓库还有另一个会话（或用户自己）可能在改代码，本会话的所有改动必须在自己的 git worktree 里进行，绝不在共享工作区动笔。涵盖：为什么同一工作区无法保证互不影响（工作区文件/暂存区/HEAD/stash 四样共享物都没有锁）、建 worktree 与硬链接 node_modules 的标准命令、「动笔前先 git status 确认改动归属」等五条铁律、以及 /tmp 清理与记忆文件误入共享区等实测坑。触发场景：用户说"另一个会话在改代码""两个会话同时改""并行开发""会不会互相影响""用 worktree""开个独立目录"，或本会话准备动笔时发现 `git status` 里有不属于自己的一改动、当前分支不是自己开的分支。注意：单会话独占仓库时维持原状即可，不必为每个小改动都开 worktree；判断依据是**有没有第二个人可能在同一工作区动笔**。
agent_created: true
---

# 多会话并行工作法：worktree 隔离（2026-11-14 实测确立）

## 零、为什么必须隔离（血泪依据）

同一工作区里，两个会话共享四样**都没有锁**的东西：

| 共享物 | 后果 |
|---|---|
| 工作区文件 | 两边改同一文件 = 后保存的覆盖前面的，git 不会提示 |
| 暂存区 index | 对方 `git add` 的半成品会被自己的 `git commit` 一并带走 |
| HEAD | 对方 `git checkout` 会把自己的未提交改动带走或卡住 |
| stash 栈 | 对方 `git stash` 会把自己改的东西一起收走（历史上真丢过引用） |

实测事故（2026-11-14）：一个会话把记忆日志写进了另一会话正在改的分支工作区，对方一旦 `git add -A` 就混进无关提交。靠 patch 备份 + checkout 撤回才救回来。

## 一、判定：什么时候必须开 worktree

- 仓库里已有**不属于自己**的未提交改动（`git status` 里的 M/?? 文件自己没动过）
- 当前分支不是自己要用的分支，且切走会影响别人
- 用户明说「另一个会话在改」「你们同时改」
- 反之，仓库干净且只有自己一个会话 → 维持原状，不必为小改动开 worktree

## 二、标准操作

```bash
# 1. 开 issue（纪律：issue → 分支 → PR）
gh issue create --title "..." --body-file /tmp/issue.md

# 2. 建隔离工作区（不要放 /tmp！）
git worktree add ~/worktrees/olua-<issue号> -b feat/<issue号>-<slug> master

# 3. 硬链接依赖（同卷秒级，免 npm ci；admin/server 视任务需要）
mkdir -p ~/worktrees/olua-<issue号>/admin
cp -al ~/workspace/olua/admin/node_modules ~/worktrees/olua-<issue号>/admin/node_modules

# 4. 在 worktree 里做全部改动，只 add 明确路径
cd ~/worktrees/olua-<issue号>
git add admin/src/index.css   # ✅ 逐个文件
# git add -A                  # ❌ 永远不用
```

## 三、五条铁律

1. **动笔前先 `git status`**：工作区里每一处未提交改动都要能说清归属；说不清 = 不是你的，别碰。
2. **只 `git add <明确路径>`**，永不用 `-A` / `-a` / `commit -a`。
3. **不碰对方的分支、stash、rebase、amend**；只在自己的 worktree 与分支里操作。
4. **worktree 建在 `~/worktrees/`**，不建在 `/tmp`——macOS 会清理 /tmp，目录没了但 `.git/worktrees` 元数据还在，`git worktree list` 会留下失效条目。
5. **记忆 / 日志等文件也服从同一条规则**：写到自己的 worktree，绝不写进共享工作区（哪怕「只是加几行日志」）。

## 四、实测坑

- **e2e 天然可并行，不用担心**：测试用 `freePort()` 动态申请端口 + `os.tmpdir()` 下带时间戳的独立 sqlite 文件（见 `server/test/e2e-status.cjs`）。两边同时跑测试互不污染。
- **唯一真正的产物冲突是构建输出**：e2e 跑的是 `server/dist/main.js`。两个会话在**同一目录**并发 `npm run build` 会拿到半成品 dist，报错原因完全误导人。worktree 各自独立 dist，此坑自动消失。
- **dev server 端口**：多会话同时起 vite 要显式错开（`npm run dev -- --port 5273 --strictPort`），5173 默认口会撞。
- **master 会前进**：另一个会话合并 PR 后 master 就变了。自己的分支 PR 前按惯例 rebase 到最新 master 再跑门禁，冲突只出现在同文件同段。
- **硬链接的边界**：`cp -al` 对 node_modules 安全（只读为主）；如果某个包运行时写自己的文件（极少见），单独 `npm install` 那个包即可。

## 五、验收

- `git worktree list` 里自己的条目指向 `~/worktrees/olua-*` 与自己的分支
- 自己的提交里没有别人的半成品文件（`git show --stat` 逐条过）
- 共享工作区在自己工作前后，`git status` 的他人改动**一字未动**
