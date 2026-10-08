#!/usr/bin/env node
/**
 * 角色删除功能的自动化验证：跑**真实的 StorageManager.deleteRole**（沙箱见 tools/lib/storage-sandbox.cjs）
 * + 对 RoleSelector 的关键接线做源码断言（「按钮建了没绑事件」正是这次要修的那类 bug，值得单独立条）
 *
 * 覆盖：
 * - 数据层：删存在的 / 不存在的 / 同名不同 id / 删到空、剩余角色数据完整、落盘真的生效
 * - 选中项：删的就是选中角色 → 清掉；删别人 → 不受影响；选中项本身是脏数据 → 顺手清掉
 * - 界面接线：「管理」按钮 → 管理模式；删除按钮挂舞台（不挂角色预览 → 不会被选中事件吞掉）；
 *   删掉选中角色后复位选中态；场景销毁清理待确认定时器；布局配置齐备
 *
 * 用法：node tools/test-role-delete.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepareStorage } = require("./lib/storage-sandbox.cjs");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const ROLE_SELECTOR_FILE = path.join(PROJECT_ROOT, "assets/ui/RoleSelector.ts");
const SCENES_FILE = path.join(PROJECT_ROOT, "assets/configs/layout/scenes.ts");
const STORAGE_MANAGER_FILE = path.join(PROJECT_ROOT, "assets/ui/core/StorageManager.ts");

let sandbox;
try {
  sandbox = prepareStorage("olua-role-delete");
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}

const { StorageManager, Role, shim } = sandbox;

/** 造一个角色并固定 id（Role 的 id 取时间戳，同毫秒会撞，测试里显式指定） */
function makeRole(id, name) {
  const role = new Role(name, "1", "1");
  role.id = id;
  return role;
}

/** 重置存档：清空全部 → 写入角色列表 → 可选写入选中角色 */
function seed(roles, selectedRole) {
  StorageManager.clear();
  StorageManager.setRoles(roles);
  if (selectedRole) StorageManager.onlineRole(selectedRole);
}

/** 存档里真实的 selectedRole 值（直接看垫片内存，不从业务接口倒推） */
const rawSelected = () => shim.__memory.get("selectedRole") ?? null;
/** 存档里真实的 roles 数组 */
const rawRoles = () => JSON.parse(shim.__memory.get("roles") ?? "[]");

console.log("— 数据层：StorageManager.deleteRole —");

// 1. 删存在的角色
seed([makeRole("r1", "张三"), makeRole("r2", "李四"), makeRole("r3", "王五")], "r2");
check(StorageManager.deleteRole("r1") === true, "删存在的角色返回 true");
{
  const ids = rawRoles().map((role) => role.id);
  check(ids.length === 2 && !ids.includes("r1"), "被删角色不再出现在列表里", `剩余 ${ids.join("/")}`);
  check(ids[0] === "r2" && ids[1] === "r3", "其它角色的顺序保持不变");
}

// 2. 剩余角色的数据完整（删一个不能动到别人）
{
  const kept = StorageManager.findRoleById("r2");
  check(Boolean(kept) && kept.name === "李四" && kept.level === 1, "剩余角色的名称/等级原样保留");
  check(kept.bag.length === 7 && kept.bag[0].length === 11, "剩余角色背包结构完好（7 行 × 11 列）");
  check(Object.keys(kept.equipments).length === 13, "剩余角色装备槽完好（13 个部位，见 types/good.EQUIPMENT_TYPE）");
}

// 3. 落盘真的生效（重新读取拿到的是删后的结果）
check(StorageManager.getRoles().length === 2, "删除已落盘（重新 getRoles 读到 2 个）");

// 4. 删不存在的 id
seed([makeRole("r1", "张三")], null);
check(StorageManager.deleteRole("nope") === false, "删不存在的角色返回 false");
check(rawRoles().length === 1, "删除失败时列表不变");

// 5. 重复删除同一 id：第二次必须失败（不能把别人删掉）
seed([makeRole("r1", "张三"), makeRole("r2", "李四")], null);
StorageManager.deleteRole("r1");
check(StorageManager.deleteRole("r1") === false, "重复删除同一 id 第二次返回 false");
check(rawRoles().map((role) => role.id).join() === "r2", "重复删除没有误伤其它角色");

// 6. 同名不同 id：只删指定 id
seed([makeRole("a", "无名"), makeRole("b", "无名")], null);
StorageManager.deleteRole("b");
check(rawRoles().map((role) => role.id).join() === "a", "同名角色只删指定 id 的那个");

console.log("— 选中项：删完不能让 selectedRole 指向已不存在的角色 —");

// 7. 删的就是选中角色 → selectedRole 清掉
seed([makeRole("r1", "张三"), makeRole("r2", "李四")], "r1");
StorageManager.deleteRole("r1");
check(rawSelected() === null, "删掉选中角色后 selectedRole 被清空");
check(StorageManager.findOnlineRole() === undefined, "此后取在线角色得到 undefined（不会进游戏卡住）");

// 8. 删别人 → 选中项不受影响
seed([makeRole("r1", "张三"), makeRole("r2", "李四")], "r2");
StorageManager.deleteRole("r1");
check(rawSelected() === "r2", "删非选中角色时 selectedRole 保持不动");
check(StorageManager.findOnlineRole()?.name === "李四", "在线角色仍能正确取到");

// 9. 选中项本来是脏数据（指向已不存在的角色）→ 顺手清掉
seed([makeRole("r1", "张三"), makeRole("r2", "李四")], "ghost");
StorageManager.deleteRole("r1");
check(rawSelected() === null, "选中项是脏数据时也会被顺手清理");

// 10. 删到空列表
seed([makeRole("only", "独苗")], "only");
StorageManager.deleteRole("only");
check(rawRoles().length === 0 && rawSelected() === null, "删光全部角色后列表为空且选中项清空");

console.log("— 界面接线：RoleSelector / 配置 —");

const selectorSource = fs.readFileSync(ROLE_SELECTOR_FILE, "utf8");
const scenesSource = fs.readFileSync(SCENES_FILE, "utf8");
const storageSource = fs.readFileSync(STORAGE_MANAGER_FILE, "utf8");

check(/manageRoleButton\.on\(Node\.EventType\.TOUCH_END, \(\) => this\.toggleManageRole\(\)\)/.test(selectorSource), "「管理」按钮已绑定 toggleManageRole（原来只建节点没绑事件）");
check(/button\.on\(Node\.EventType\.TOUCH_END, \(\) => this\.onDeleteRoleClick\(role\.id, button\)/.test(selectorSource), "每个删除按钮都绑定了 onDeleteRoleClick");
check(/this\.stage!\.addChild\(button\)/.test(selectorSource), "删除按钮挂在舞台上（不在角色预览子树 → 点删除不会冒泡成选中角色）");
check(/if \(this\.ownerRoleSelectedId === roleId\) this\.clearSelectedRole\(\)/.test(selectorSource), "删掉选中角色时复位选中态与开始游戏按钮");
check(/onDestroy\(\)[\s\S]{0,200}this\.cancelDeleteConfirm\(\)/.test(selectorSource), "场景销毁时清理待确认定时器");
check(/setTimeout\(\(\) => this\.cancelDeleteConfirm\(\), roleSelectorLayout\.manageRole\.confirmTimeout\)/.test(selectorSource), "两步确认带超时自动复位");

check(/manageRole:\s*\{[\s\S]*deleteButtonOffset[\s\S]*deleteButtonSize[\s\S]*confirmTimeout[\s\S]*hint:/.test(scenesSource), "manageRole 布局配置齐备（偏移/尺寸/超时/提示条）");

check(/static deleteRole\(id: string\): boolean \{/.test(storageSource), "StorageManager 暴露了 deleteRole");
check(/!roles\.some\(\(role\) => role\.id === selected\)/.test(storageSource), "deleteRole 会校验并清掉指向已不存在角色的选中项");

console.log("— 服务端联动：落盘写穿，本地删不推服务端 —");

// 角色数据以服务端为准：本地落盘只是缓存，任何改动都要写穿过去（见 ui/utils/net/RoleSync）；
// 但「本地清缓存」与「服务端删除」是两件事 —— 真删由选角场景先调 RoleApi.remove，这里不推
const { RoleSync: roleSyncStub, Session: sessionStub } = sandbox;
roleSyncStub.scheduled.length = 0;
seed([makeRole("r1", "张三")], "r1");
check(roleSyncStub.scheduled.length === 0, "重建存档（setRoles / onlineRole）不推服务端");

StorageManager.updateOnlineRole(StorageManager.findOnlineRole());
check(roleSyncStub.scheduled.length === 1 && roleSyncStub.scheduled[0].id === "r1", "updateOnlineRole 落盘后安排一次同步（本地落盘唯一出口 = 同步唯一触发点）");

roleSyncStub.scheduled.length = 0;
StorageManager.deleteRole("r1");
check(roleSyncStub.scheduled.length === 0, "deleteRole 不推服务端（只清本地缓存，真删由选角场景调服务端接口）");

const clearedBefore = sessionStub.cleared;
StorageManager.clear();
check(sessionStub.cleared === clearedBefore + 1, "clear() 连带清掉会话（清存档别留着上个账号的登录态）");
check(typeof StorageManager.createRole === "undefined", "本地 createRole 已移除（创建必须走服务端，见 RoleSelector.createRole）");

finish("PASS: 角色删除的数据行为与界面接线全部通过");
