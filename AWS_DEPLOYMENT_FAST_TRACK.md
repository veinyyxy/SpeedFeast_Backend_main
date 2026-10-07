# AWS 自动部署最快交付：服务端继续位置

2026-10-05 用户要求以单租户真实部署闭环为优先，取消原最低费用优先策略；新预算目标为 **50 USD/月**。完整方案由 TechlongSoftware 的 `docs/aws-auto-deployment-fast-track.md` 维护，服务端与平台仍保持独立仓库，直接提交/推送 main。

2026-10-07 F2c 第一批已完成：新增真实 `PostgresTenantSaasTransactionProvider` 的 `migrate_saas/verify` SQL phase。在隔离 PG16.14 TLS、非 superuser cell_admin 上验证真实迁移、rollback、重放、COMMIT 响应丢失恢复、管理会话丢失中止和旧 epoch 拒绝，独立只读进程证明 1 条 singleton、8 条默认 entitlement、其余业务表零行。所有临时实例停止，无源 PG15/AWS/Neon 写入；baseline 未批准，runtime 未启用。prepare/restore/RDS/生产 CLI/镜像接线仍待完成。

## F2c 第一批：真实 SaaS 事务 provider

新模块不导入 `.env` 或开发数据库 pool，仅装载两个固定 image SQL 文件（LF canonical SHA：saas_control `4da7a9d7974efa0cbab6196bc21a7618c052c11bec8cdd4390e2e24f0d22c8bf`，theme_config `eec8838c01101f009b18f838525a64e100e59300c460a52006cb96568c809c14`）。接受已连接的管理/租户会话，核对 PG16.14/TLS/实际同一 server 和准确 role/database，在 cleanup 同一 management advisory lock 下核验完整 ownership/epoch/operation/baseline 前驱，目标事务里执行迁移/种子回读并原子更新两项 marker。不创建/接管部分资源、不采用不同 epoch、不启用默认 factory。未来 caller 仍须绑定真实 RDS endpoint/CA、Secret/receipt/连接生命周期。

实际工具 `scripts/verify-tenant-saas-transactions-pg16.js` 使用全新本地 cluster、自签短期本地 TLS（没有系统信任库修改）、SCRAM 随机密码，fixture 初始化账号/基线不作为 prepare/restore provider 实现证明。成功目录 `F:/ChatGPT_workshop/techlong-pg16-saas-transactions-20261007-f2c4`，收据 SHA `47628692f09207e3596b221d4318991796ca73be322832543aa46a440b6957e9`，结果 `SAAS_TRANSACTION_REAL_PG16_VERIFIED`。原 archive/manifest 未变，所有失败/先前成功目录保留，四个实例均已停止；私有证书/key/archive/cluster/收据不入 Git。

41 项 Node 相邻回归、28 项既有 Python baseline/profile 测试、typecheck/语法/diff check 通过。现有生产 CLI/factory 仍仅 inspect/cleanup-only destroy；SQL phase 的 verified 不等于运行账户/ECS/对外 tenant ready。[完整本批次证据和继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2c-saas-transactions.md)。

下一批实现 prepare 的非事务创建/准确 ownership/崩溃恢复/失败清理，restore 的受批 immutable artifact 校验/原子 marker，再接 RDS/CLI/receipt/镜像。真实云发布、baseline 批准仍各按新的准确清单，不沿用过期 Grant。

2026-10-06 F2b 完成真实独立 PG16.14 baseline 恢复验收；以下记录保留原阶段状态。

2026-10-05 F2a 完成空 baseline 候选工具和真实 schema-only 导出/逐项 schema profile 核验；以下 F2a 记录按当时状态保留。

## F2b 真实 PG16 验收

新增 `scripts/verify-empty-tenant-baseline-pg16.js`：不读源 `.env`，仅接受 artifact workspace 内的 candidate/便携 binary/新输出目录及明确 archive/manifest SHA；冻结副本、恢复前再复算、SCRAM 随机密码、loopback/非 5432 端口、data directory/version/role/database 实读绑定。`pg_restore` 单事务恢复后，独立只读 psql 会话执行现有零行/profile SQL，再另起 Node pg 只读 inventory/行数回读；成功或失败都尝试停止准确临时实例，不覆盖、清空或重放占用目录。

成功目录 `F:/ChatGPT_workshop/techlong-pg16-baseline-verification-20261006-f2b3`，结果 `PG16_RESTORE_EMPTY_PROFILE_VERIFIED`；实际版本 160014、73 张表、0 行、10 个程序对象、`isolatedServerStopped=true`。收据 SHA `9b4b2ce704f87c08676a6b7d3f74514296d8d2863c6f25ec59dc5bba57735b27`。原 archive/manifest 与下文 F2a SHA 一致，`baselineApproved=false`；原候选收据保持原状，真实恢复证据保存在独立新收据，不改写历史。

PG16.14 官方 EDB 便携 ZIP 仅展开 bin/lib/share 到 `F:/ChatGPT_workshop/techlong-pg16-20261006/portable`；没有 Windows 安装器、服务注册或 PATH 修改。前两个全新实例分别遇到 pg_ctl 输出句柄等待、inet::text 含 /32 的 identity 误判，均在 restore 前拦截并停止；修复和必要回归后才完成真实恢复，失败目录保留。没有用 source PG15 作为验收目标。

本批次 14 项 Node 必要相邻回归、28 项既有 Python baseline/profile 测试、类型检查通过。仅本地临时实例 `ssl=off`，生产 RDS verify-full/CA、IAM/ownership/runtime 拒绝边界均未改。工具/测试入 Git，私有 binary、archive、SQL、cluster、日志、收据不入 Git。[完整真实验收证据与边界](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2b-pg16.md)。

2026-10-07 准确 seed 口径补充：空 baseline 迁移产生 1 条 singleton、8 条 entitlement；主题是两类 × 每 store × 四环境，无 store 时 system_config 为 0 行，不是无条件两行。必须区分 baseline 全空与迁移后初始化行。不能调用读取 `.env` 的开发迁移入口，也不能把本地恢复称为 Aurora/镜像/Worker 在线证明。

## 候选导出

`scripts/build-empty-tenant-baseline.js` 从本仓库 `.env` 只读取本地 PG 连接设置，通过 child environment 传递凭据，命令参数、控制台与收据均不包含密码。强制 `--schema-only`、read-only PGOPTIONS，拒绝非 localhost 的源数据库。不读取业务表行，不删除源对象。

离线 `pg_restore --list` 后，`compile_tenant_baseline_candidate.py` 复用现有严格 validator。约束/索引等 schemaObjectAllowlist 仅用于候选审阅，不等于用户批准；不接受 TABLE DATA、sequence values 或 blobs。默认 profile 仍拒绝 extension/trigger 和额外函数。兼容性不通过时保留候选与具体私有诊断，不能自动尝试恢复。

明确传入 `--schema-profile speedfeast-empty-schema/2026-10-05/v1` 才使用代码审阅的新 profile：仅接受 `uuid-ossp`、5 个固定函数和 4 个固定 trigger。`tenant_baseline_schema_profile.py` 保存不含业务数据的确切定义，并与离线渲染的**完整对象定义**比较；不接受名称相同但 body/权限/绑定已变化的对象，不接受缺失/重复或额外程序对象。购物车合计和更新时间行为不被删除。此检查不是通用 SQL 沙箱，完整 archive/manifest SHA 仍须独立批准。

迁移镜像已接入此 profile；SQL 在任何目标连接前离线渲染/校验。安装后验证 SQL 还检查扩展 1.1/public、函数 body/language/volatility/非 SECURITY DEFINER 和启用的准确 trigger。没有执行该迁移镜像，也未把旧 manifest 自动切换到新 profile。

示例（替换成一个不存在的新目录与本机 Python 路径）：

```powershell
node scripts/build-empty-tenant-baseline.js `
  --output F:/ChatGPT_workshop/techlong-empty-baseline-NEW `
  --pg-bin E:/pgsql/bin `
  --python C:/path/to/python.exe `
  --schema-profile speedfeast-empty-schema/2026-10-05/v1
```

产物为 `.dump`、`.toc.txt`、candidate manifest、schema-policy review、candidate receipt，以及通过 TOC 校验时的空行验证 SQL。它们必须保留在 Git 忽略的 artifact workspace，不能公开提交 schema archive；即使 TOC 合格，仍须 PostgreSQL 16.14 restore/独立回读和明确 baseline 批准。

## 当前真实证据与阻断

首次实际运行目录：`F:/ChatGPT_workshop/techlong-empty-baseline-20261005-f2a`。

首次源连接独立只读诊断返回 `ECONNREFUSED`；0 字节 dump 保留为失败记录。用户启动本地 PostgreSQL 后，新目录 `F:/ChatGPT_workshop/techlong-empty-baseline-20261005-f2a2` 导出成功，但 legacy policy 拒绝必要扩展。`f2a3` 保留 extension 空 owner 字段解析失败记录，不覆盖。最终 `F:/ChatGPT_workshop/techlong-empty-baseline-20261005-f2a4` 已通过显式 profile：73 张表、203375 字节 schema-only archive，10 个程序对象逐项相符，没有 TABLE DATA。

- archive SHA：`1a65288b4628018932a8d9af4658db5702b6cf49966a2032bc2d919bc591d70a`
- candidate manifest SHA：`62b5dc8cadcf276df140be86e002a08b64d9b713bd0257e14ac515c12a996971`
- 收据结果：`CANDIDATE_REQUIRES_PG16_RESTORE_AND_APPROVAL`；`baselineApproved=false`、`pg16RestoreVerified=false`。

F2a 当时没有源库写入、restore、AWS/Neon 调用或上传，仅有本地 pg_dump 15.3，尚无 PostgreSQL 16.14 验收环境。F2b 现已通过上述独立便携实例真实验收，原开发源库未作为 restore 目标；生产批准/immutable baseline 发布仍未执行。

接着需要完成 production `prepare_empty_database / restore_approved_baseline / migrate_saas / verify` provider，以及镜像构建/准确 readback。现有 production runtime 仍只允许 inspect/cleanup-only destroy，没有打开新命令，未运行 ECS task。

本批次验证：Node 候选/迁移镜像/lifecycle 相邻回归 39 项、Python 候选/legacy/profile 验证 28 项通过；类型检查通过。独立进程复验相同 archive/manifest/TOC/SQL 后，验证 SQL 与候选逐字节一致（已统一 LF 输出；最初 CRLF 比较记录保留）。私有 schema archive/SQL/manifest/收据均未提交 Git。

官方兼容性资料：[Aurora PostgreSQL 扩展列表](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html)、[PostgreSQL 16 uuid-ossp](https://www.postgresql.org/docs/16/uuid-ossp.html)。文档支持不代替本账户目标引擎上的真实验收。
