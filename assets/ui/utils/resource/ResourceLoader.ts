import { Asset, resources } from "cc";

/**
 * 资源加载
 * 把 resources.load 的回调式接口封装成 Promise，便于用 await 串联「加载完成后再初始化」的流程
 */
export function loadResourceAsync<T extends Asset>(path: string, type: typeof Asset): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    resources.load(path, type, (err, asset) => {
      if (err) {
        console.error(`资源加载失败：${path}`);
        reject(err);
      } else {
        resolve(asset as T);
      }
    });
  });
}
