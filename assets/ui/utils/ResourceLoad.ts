import { resources, Asset } from "cc";

/**
 * 将 resources.load 封装为 Promise
 * @param path 资源路径，相对于 resources 目录，不含扩展名
 * @param type 资源类型构造函数
 */
export function loadResourcesAsync<T extends Asset>(name: string, path: string, type: typeof Asset): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    resources.load(path, type, (err, asset) => {
      if (err) {
        console.error(`${name}加载失败。`);
        reject(err);
      } else {
        resolve(asset as T);
      }
    });
  });
}
