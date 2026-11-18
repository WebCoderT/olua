/**
 * StorageManager 源码读取兼容层（#1115 批次 6）
 *
 * StorageManager 拆分后，实现搬进 ui/core/storage/ 各子模块，facade 只剩转发。
 * 断言测试关心的是**方法体形状**（分发、收权、乐观锁），把 facade 与全部子模块拼接
 * 成一份「虚拟 StorageManager 源码」，并把子模块里的跨模块调用反适配回类方法互调的
 * 旧形状（RoleCache.updateOnlineRole( → this.updateOnlineRole( 等）—— 旧断言零改动。
 */
const fs = require("fs");
const path = require("path");

const STORAGE_DIR = path.join(__dirname, "..", "..", "assets", "ui", "core", "storage");

function storageSourceFor(facadePath) {
  const facade = fs.readFileSync(facadePath, "utf8");
  const parts = fs
    .readdirSync(STORAGE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => fs.readFileSync(path.join(STORAGE_DIR, f), "utf8"))
    .join("\n");
  // 子模块（真实现）在前：断言用「首次出现」定位方法体，不能让 facade 的委托行抢先命中
  return (parts + "\n" + facade)
    .replace(/RoleCache\.updateOnlineRole\(/g, "this.updateOnlineRole(")
    .replace(/RoleCache\.findOnlineRole\(\)/g, "this.findOnlineRole()")
    .replace(/RoleCache\.ensureRoleDefaults\(/g, "this.ensureRoleDefaults(")
    .replace(/RoleCache\.applyServerRevision\(/g, "this.applyServerRevision(")
    .replace(/updateRoleUi\(role\)/g, "this.updateUi(role)")
    .replace(/FashionService\.applyFashionChange\(/g, "this.applyFashionChange(")
    .replace(/MapTransition\.markTeleportArrival\(\)/g, "this.markTeleportArrival()")
    .replace(/MapTransition\.applyMapChange\(/g, "this.applyMapChange(")
    .replace(/GrowthService\.upgradeGrowthOnServer\(/g, "this.upgradeGrowthOnServer(")
    .replace(/BagService\.runBagOp\(/g, "this.runBagOp(")
    .replace(/BagService\.sparseBagCells\(/g, "this.sparseBagCells(")
    .replace(/BagService\.bagIsEmpty\(/g, "this.bagIsEmpty(")
    .replace(/BagService\.bagSignature\(/g, "this.bagSignature(")
    .replace(/BagService\.collectBagEquipmentEntries\(/g, "this.collectBagEquipmentEntries(")
    .replace(/BagService\.applyEquipmentChange\(/g, "this.applyEquipmentChange(")
    .replace(/BagService\.equipFromBag\(/g, "this.equipFromBag(")
    .replace(/BagService\.equipBetterFromBag\(/g, "this.equipBetterFromBag(")
    .replace(/BagService\.findBetterEquipmentInBag\(/g, "this.findBetterEquipmentInBag(")
    .replace(/BagService\.useDrug\(/g, "this.useDrug(")
    .replace(/BagService\.useMoneyItem\(/g, "this.useMoneyItem(")
    .replace(/BagService\.useLevelScroll\(/g, "this.useLevelScroll(")
    .replace(/getGoodDisplayName\(/g, "this.getGoodDisplayName(");
}

module.exports = { storageSourceFor };
