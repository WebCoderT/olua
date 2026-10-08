import { Module } from "@nestjs/common";
import { AdminAccountsController } from "./admin-accounts.controller";
import { AdminAdminsController } from "./admin-admins.controller";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthService } from "./admin-auth.service";
import { AdminRolesController } from "./admin-roles.controller";
import { AdminService } from "./admin.service";

/**
 * 管理端模块
 *
 * 四个控制器都标了 `@ApiAudience("admin")`：只有管理员令牌能调用；
 * 新增管理端接口时**必须**带上这个装饰器（否则默认按玩家接口处理，玩家令牌就能进来），
 * 并用 `@ApiAdminDoc({ permissions })` 声明所需权限点（见 common/guards/permission.guard）。
 */
@Module({
  controllers: [AdminAuthController, AdminAccountsController, AdminRolesController, AdminAdminsController],
  providers: [AdminAuthService, AdminService],
})
export class AdminModule {}
