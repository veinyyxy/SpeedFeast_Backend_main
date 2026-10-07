# AWS 自动部署最快交付：服务端继续位置

2026-10-05 用户要求以单租户真实部署闭环为优先，取消原最低费用优先策略；新预算目标为 **50 USD/月**。完整方案由 TechlongSoftware 的 `docs/aws-auto-deployment-fast-track.md` 维护，服务端与平台仍保持独立仓库，直接提交/推送 main。

2026-10-07 F2c 第三批完成原子 baseline restore 与真实 prepare→restore→migrate→verify SQL 链。应用账户仍 NOLOGIN，生产 factory/CLI、正常清理、RDS/receipt/镜像和云启用仍待接线；以下既有记录保留当时状态。

## F2c 第三批：原子 restore 与固定结构回读

新增 `tenant_baseline_program.js`：对有界 archive/manifest bytes 冻结副本，离线 pg_restore16.14 TOC/schema-only 输出并复用严格 Python validator，目标连接之前编译。准确外层 restrict pair 移除，拒绝其他 client command、事务控制/数据/角色/数据库管理语句；renderer timeout=0 不执行，其余固定设置 LOCAL，不向 borrowed session 泄漏设置。编译对象冻结且带私有进程内品牌，不接收自报 SQL。完整 archive SHA 受批仍必要，这不是通用 SQL sandbox。[pg_restore 官方输出/安全说明](https://www.postgresql.org/docs/16/app-pgrestore.html)。

`tenant_baseline_restore_provider.js` 在共享 management lock 下核对 prepare journal、准确 role/database OID、NOLOGIN/ownership/ACL 和完整 provision fence，绑定目标 backend 实际 datid。目标事务原子恢复、验证 73 表零行/profile/固定结构 catalog pin、更新双 ownership marker；失败 rollback，commit 响应丢失只在独立读取准确 marker/实际结构一致后判定 already_applied，重放目标事务 READ ONLY。无 --clean、down migration、LOGIN/grant 激活或默认 factory 放宽。

`tenant_baseline_catalog.js` 固定当前 archive/manifest 的逻辑结构 pin，覆盖列/default、约束/索引、sequence 静态参数、trigger/function/ACL、schema/type/extensions 等；不包含业务行/统计或物理 OID，uuid-ossp script owner 规范化。新候选必须代码审阅新 pin，不由目标自动学习；实际 Aurora/extension/locale 差异仍待后续验收。archive/manifest SHA 延续 F2a4；restore SQL SHA `db6508986edd25344fcd8fc5763ccc33e2eea01b4659fb4771660f998640bbda`，verification SQL SHA `c676d7d47fe45f50c6c1ccecb0eefdae4b3eb9397ffdf62d8ef89b7a55043303`，catalog SHA `d27dc20410e0cceac97a49bfd72a0bcc7fa197b25d512d2b941df0a70ae1d55b`。

最终目录 `F:/ChatGPT_workshop/techlong-pg16-baseline-restore-20261007-f2c4`，收据 SHA `de92cb59884ced7853696c404abb5f75bd37d8ff574407ada5e25b88208bed4f`，结果 `BASELINE_RESTORE_REAL_PG16_VERIFIED`。非 superuser/TLS 实测非空拒绝、DDL/marker rollback、实际非批准行导致零行拒绝并 rollback、真实管理 backend termination/end 导致 rollback、正常 applied/只读 replay、GUC 恢复、旧 epoch 拒绝、独立 psql+readonly Node catalog 验证、真实 SQL 四阶段链、commit 成功但响应丢失恢复及额外列漂移拒绝。baseline 73 表零行；迁移后初始化 1+8 行，空 stores 的主题为 0 行。四个本轮实例由独立 pg_ctl status 证明停止，所有校准/早期成功目录保留。

62 项 Node 相邻回归、28 项 Python 严格校验、backend typecheck 通过。私有 archive/SQL/manifest/key/cluster/原始收据不入 Git。没有 source PG15、AWS/Neon 写入，没有 baseline 生产批准/上传、runtime 或 paid Cell。下一步集中补生产组合：partial-state recovery、normal destroy/journal/新 generation 释放、应用权限/LOGIN/真实登录、RDS factory/CLI/receipt/镜像；旧 cleanup registry 未迁移。生产和云变更仍各按 fresh SHA 单独批准，不使用过期 Grant。[完整本批次证据](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2c-atomic-restore.md)。

2026-10-07 F2c 第二批已完成 prepare/失败补偿 SQL capability，真实 PG16.14 TLS、非 superuser cell_admin 验收通过；runtime、生产 baseline 批准和云部署仍未启用。下一小阶段是 restore；下文第一批记录保留其当时状态。

## F2c 第二批：准确 prepare、恢复和失败补偿

`tenant_prepare_provider.js` 与 additive `tenant_prepare_journal.sql` 实现永久 reservation/CREATE intent/准确 OID、专属 NOLOGIN guard owner、禁止连接 quarantine、原子 empty ownership promotion、pending prepare 失败补偿和永久终态。完整 journal catalog SHA 固定为 `437c901ffaa790c57318f7de874567ae80993becd6dc0430b0911b734860c7da`，漂移拒绝；共享 cleanup advisory lock 键。同名 foreign resource/重建 OID/旧 epoch 均不接管或删除；无 FORCE、DROP OWNED、wildcard 或槽位复位。prepare 成功仍 app NOLOGIN/PUBLIC database 权限关闭，不声称运行账户登录或 tenant ready。

现有五键 Secret 校验提取出共用 `assertRuntimeDatabaseReference`，SQL capability 仅接收 `{database_url}`，不接收 HMAC/JWT/支付值；完整 Secret callback 原约定保持。已连接 session 仍由可信 caller 借用；真实 RDS endpoint/CA/Secret/session 生命周期、生产日志策略尚待工厂接线。

真实工具 `scripts/verify-tenant-prepare-pg16.js` 使用 fresh local TLS/SCRAM fixture、非 5432 loopback 和新 data directory；不读 `.env`、不联系源 PG15/AWS/Neon。最终目录 `F:/ChatGPT_workshop/techlong-pg16-prepare-20261007-f2c10`，收据 SHA `97a880aafa6f74676c670d46d17dde7a53b40b9a027afa4fb10c7875a91ed8d2`，结果 `PREPARE_REAL_PG16_VERIFIED`。实际验证 fresh/replay、reservation/CREATE/final COMMIT 响应丢失重连恢复、promotion rollback、DROP DATABASE 响应丢失补偿恢复、永久记录/ACL/trigger、foreign name/重建 app OID/旧 epoch/外来 database ACL 拒绝、catalog 漂移拒绝，以及独立只读 psql。所有十个实例由独立 pg_ctl status 证明停止，失败/早期成功目录保留；f2c8 的 15 秒本地 DROP 超时记录保留，后续仅提高隔离 fixture 等待时限复验，生产时限不变。私有 keys/cluster/收据不入 Git。

45 项相邻 Node 回归、backend typecheck 通过；bounded metadata/DDL 引号与反斜杠转义已验证。平台本地 runtime 诊断仍 disabled、50 USD/月，无数据库或云访问。早期 PG16 实测纠正了 guard SET-only 不足以继承 ownership、bootstrap ADMIN grant 与显式 membership 共存的假设；仅给 guard 管理成员所需 SET/INHERIT，成功后删除 guard。参考 [PG16 role attributes](https://www.postgresql.org/docs/16/role-attributes.html) 和 [CREATE DATABASE 非事务限制](https://www.postgresql.org/docs/16/sql-createdatabase.html)。[完整本批次证据](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2c-prepare.md)。

下一步 restore 的受批 immutable artifact 校验/原子 marker/rollback 和提交响应丢失恢复；然后接 prepare partial-state recovery、已完成 prepare 的正常 destroy 与 journal/generation 释放、RDS factory/CLI/receipt/镜像。新 journal 仅安装于本轮 fresh local cluster，旧 cleanup registry 未迁移，service 仍拒绝 partial observation，默认 production factory 仍 inspect/cleanup-only destroy。不能直接启用这个 SQL 模块或把本地验收等同 Aurora/Worker 在线验收。所有运行门禁 false，实际云发布和 baseline 批准仍按 fresh SHA 单独批准。

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
