import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "olua:isPublic";

/** 标记接口无需登录（注册 / 登录 / 健康检查） */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
