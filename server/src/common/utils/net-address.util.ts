import { networkInterfaces } from "node:os";

/**
 * 本机对外可用的 IPv4 地址（启动日志用）
 *
 * 为什么需要它：局域网真机调试时，手机该填哪个地址是**电脑的网卡地址**，而
 * 启动日志原来只打 `localhost` —— 那个地址在手机上指的是手机自己，照着填必然连不上。
 * 这里把网卡地址直接列出来，省得每次去 `ifconfig` / 「系统设置 → 网络」里翻。
 *
 * 只取 IPv4 且**非内部**地址：IPv6 链路本地地址（fe80::）在手机上手填几乎不可能写对，
 * 回环地址（internal）在别的设备上没有意义。
 *
 * 这是**只在日志里用**的展示辅助，不参与监听绑定（绑定看 config 的 `host`）。
 */
export function lanIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const items of Object.values(networkInterfaces())) {
    for (const item of items ?? []) {
      if (item.family !== "IPv4" || item.internal) continue;
      addresses.push(item.address);
    }
  }
  return addresses;
}
