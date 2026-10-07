# AWS 自动部署最快交付：服务端继续位置

2026-10-05 用户要求以单租户真实部署闭环为优先，取消原最低费用优先策略；新预算目标为 **50 USD/月**。完整方案由 TechlongSoftware 的 `docs/aws-auto-deployment-fast-track.md` 维护，服务端与平台仍保持独立仓库，直接提交/推送 main。

## F2f5 登录前置检查修正：旧批准未执行，新SHA待确认

2026-10-07 用户批准 `c9fa6086...` 后，前置只读检查发现AWS Login导出的当前临时凭据仅约14分钟，而旧执行器要求一小时，未进入写入口/永久执行槽位。这个检查把可自动刷新的15分钟凭据误当成整个登录会话期限；不是用户刷新失败。额度恢复后Source真实只读调用仍成功，当前profile实际为login provider。

已修正为准确Source profile/login_session/provider/STS身份、支持login的CLI版本、当前凭据至少120秒；每个AWS调用仍使用profile自动刷新，Grant/Revoke前复验，不把keys冻结到环境，也不声称已证明整个refresh session剩余时间。17项定向测试/语法通过，真实ReviewOnly再次证明Locked/v2/UPDATE_COMPLETE、准确两资源/零attached/完整policy和trust；两artifact仍准确且有效、新tag仍absent。旧已批准但未执行清单原文保留在 `deployment/history/reviewed-ecr-publication-c9fa6086.json`，旧Git源 `9bd3560e5e1c576b543aea30bd35a33e3feda50f` 保留原执行器。

新fresh清单文本SHA `15d30e5ec70feb4712c572a404f437405b5d5b9704acd59937423ac4bbd62f80`。仅认证前置检查/对应executor hash和review记录改变，两IAM模板、两镜像/扫描/tag、权限范围、安装/发布截止和单次写槽位规则均与旧c9fa清单一致；需要用户准确批准后才能执行，不继承旧批准去绕过哈希。截止仍2026-10-08T18:00:00Z开始安装/18:45Z权限结束；立即Source Revoke和独立Locked仍必需，若自动刷新或撤权失败则报告需要处理，不继续新Grant/重试。无AWS资源写入、ECR发布、ECS/Cell或数据库变化，50USD/月目标不变。见 [修正、新审批与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2f5-login-preflight-fix.md)。以下保留修正前审阅时的历史状态。

## F2f 第五批：修复镜像 fresh 发布审阅，尚未执行

2026-10-07 新清单 `deployment/reviewed-ecr-publication.json` schema2、UTF-8 LF SHA `c9fa6086f28c8e599f40baf1d1f20ef937d2fcb9d2346bdd5376cc1d2a1c4790` 已绑定第四批成功源/run、两个原始ZIP/receipt/config/前置OS scan与四个执行器。原已消费清单原文保留在 `deployment/history/reviewed-ecr-publication-ce32e464.json`，原Grant/Revoke模板未改；新增日期固定的Regrant模板只更新现有Locked栈的两项IAM资源，不创建或替换。

新 `scripts/publication/run-reviewed-ecr-republish.ps1` 默认ReviewOnly，RunReviewed须准确fresh SHA、Source至少一小时剩余会话、Locked/v2和准确两资源回读、本地/远端main一致、成功候选/未过期artifact与两个新immutable槽位未占用。永久新槽位和冻结模板先于写入；至多一次Source Update、一次manual dispatch，成功或失败finally立即Source Revoke并独立Locked。Inspect可在候选/清单过期后只读恢复；不自动重试、清空槽位或延长日期。

16项发布/镜像/扫描相邻Node测试、JS与PowerShell语法通过。两ZIP约154MB实际下载并流式核验完整ZIP和全部成员checksum/receipt；真实收据runtime及OS scan与清单一致，没有本地Docker加载。AWS只读ValidateTemplate两模板通过，新控制器真实ReviewOnly证明准确栈UPDATE_COMPLETE、boundary default v2/唯一inline DenyAll/trust Deny、零attached policies和两原资源。私有review index SHA `b91491f367ffdfa220299fd57b9f12b49a64c3908975f37fc3aaaf476319b399`，目录 `F:/ChatGPT_workshop/techlong-reviewed-ecr-republish-f2f5-20261007`；无AWS/数据库写入或新ECR镜像。

安装最迟温尼伯2026-10-08 **13:00 CDT**（18:00Z），权限/发布截止13:45（18:45Z），最早artifact失效14:30:55（19:30:55Z）。本轮仅审阅；用户新SHA确认且Source刷新后才能更新existing publisher role/boundary、在现有sandbox ECR发布这两个修复镜像，独立BASIC/HIGH-CRITICAL扫描和manifest/config回读，再立即Locked Revoke。旧镜像/资源/所有记录保留；没有ECS/Cell、Worker/root、真实baseline或源PG15/Neon授权，50USD/月目标不变。详见 [准确发布范围与确认](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2f5-republish-review.md)。以下为历史状态。

## F2f 第四批：最小运行层与发布前OS门禁通过

2026-10-07 源 `40b1ce6e487dc4c1187da3014a89b9379d50d578` 的 [双镜像运行37674970489](https://github.com/veinyyxy/SpeedFeast_Backend_main/actions/runs/37674970489) 和 [完整Backend CI37674970442](https://github.com/veinyyxy/SpeedFeast_Backend_main/actions/runs/37674970442) success。app/lifecycle采用精确distroless cc-debian13 nonroot层，Node24.18.0不变；lifecycle精确pg_restore16.14 trixie＋官方Python3.14.8，真实SSL补丁/CA/SQL/bundle/依赖bytes与metadata/五表合成compiler/read-only-network-none/write-gate自检通过，无生产baseline或CLI授权变更。

`build-lifecycle-runtime.py` 只保留所需ELF、非GUI stdlib和准确包metadata，实际去除Perl/包管理器/Tk/curses/readline/nativeuuid；不通过删保留组件metadata或ignore-unfixed规避扫描。COPY/tmpfs的sticky1777/nonroot0700子目录问题修复。应用旧OpenSSL HIGH由新前置扫描实际发现并同步更新基底；业务代码不改。

新Trivy0.75.0固定tar SHA、job-local新DB、准确image/受支持OS/完整包清单/48h DB校验，OS HIGH/CRITICAL门禁先于镜像保留。app14包/lifecycle32包，两者HIGH0/CRITICAL0，npm audit gate与完整CI通过；这不等同未来ECR BASIC扫描，原ECR门禁不降低。小scan proof绑定candidate receipt，四文件promotion ZIP结构不变。各失败run和日志保留，私有完整索引在F工作区，不入Git。

新app config digest `sha256:f82596ef5dae6229a629a07b37cfce5b0ece9b99fc63d939af997fbde9c40f49`、receipt SHA `fcdcc0abee0393820a4c190e593330a9af3357d37d2f2a00b4eec488fc1b65d0`；lifecycle config `sha256:cc342bcc242b9c3ae9d61d9b94c27053e7e8c8a2bc32347f54368848d76ea5af`、receipt SHA `46a825ce303b87312075db66417f20731aa28989035fa5ff1dfcc0aca57bc45e`。尚未产生新ECR registry digest，候选最早2026-10-08T19:30:55Z过期。

Source结束只读核验原IAM栈UPDATE_COMPLETE、boundary v2/inline DenyAll和trust Deny；本批无AWS/ECR/数据库写入、付费Cell或Worker运行，旧镜像不删除，50USD/月目标保留。下一步准备精确新候选与现有Locked栈显式更新的fresh发布清单，单独批准后再发布/独立ECR扫描/立即Revoke；不得复用已消费旧创建清单。见 [完整修复、验证与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2f4-minimal-runtime.md)。以下为历史状态。

## F2f 第三批：实际ECR写入、扫描门禁失败与Locked收尾

2026-10-07 原清单 `ce32e46450cd18f382d67de843eeaf208be9421beed80dc7cb94ed6d335abc10` 获用户明确批准。Source创建专用栈 `techlong-sandbox-github-image-publication`，仅publisher role和boundary两IAM资源，独立Grant回读通过；[单次发布运行37668582570](https://github.com/veinyyxy/SpeedFeast_Backend_main/actions/runs/37668582570)在publisher main `9520858b0331c4e43017f27258293618c79d83e2`上实际完成ZIP/receipt/checksum/image校验与OIDC登录，并写入两个精确immutable tags。

app registry digest `sha256:1c60a09f37c84cc45979e218bd5c221b60cd51200fea7cfd2b0701d334dfb610`，BASIC scan COMPLETE/空findingSeverityCounts；lifecycle digest `sha256:c24f2c8847ffd5e95faf815a39d7ac7387334e5602f61be94c7774159c5d1014`，COMPLETE/6 CRITICAL、19 HIGH、12 MEDIUM、5 LOW。独立Source BatchGetImage验证两个原config pin和registry原始manifest bytes SHA，未混用两种digest。阻断来自bookworm运行层系统包（gcc-12/pcre2/perl/python3.11/util-linux/zlib），不是MFA/Source/权限错误或npm audit失败。未豁免扫描门禁。

Source finally立即应用原Revoke模板，栈UPDATE_COMPLETE；boundary default v2与inline为DenyAll，OIDCtrust为Deny，零attached policies、原两资源完整独立回读。两个镜像和历史记录保留，无rebuild、第二dispatch/Grant/Push、ECS/Cell/源PG15/Neon/Secret/baseline写入；旧Worker/生产CLI仍disabled。执行非零反映扫描阻断，`PUBLICATION_INCOMPLETE`不表示镜像未写入。

私有证据目录 `F:/ChatGPT_workshop/techlong-reviewed-ecr-publication-ce32e464-20261007` 永久占用；Locked读回SHA `254edf45b0b4879c299ea7af81fea8fafc741eee2b2f15baa8f1a4a9bda696a3`；云端receipt SHA `e62be0f857e9db13fd66a23a662b73e9b718f910b82fd853a1588369817e9829`。[完整执行记录与下一步](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2f3-ecr-scan-blocked.md)。下一步先更新/精简lifecycle系统依赖、Actions重新构建自检，新发布必须fresh image/manifest及对现有Locked栈的明确更新批准；不重放本清单或降低HIGH/CRITICAL门槛。50USD/月目标保留。以下为历史状态。

## F2f 第二批：Actions 真实镜像与 ECR 发布准备

2026-10-07 用户选择云端构建，不安装本地 Docker/WSL。源 `acc8ae648119e8ad5cca98b8af1907eef09bf213` 的 [镜像运行 37662382372](https://github.com/veinyyxy/SpeedFeast_Backend_main/actions/runs/37662382372) 与 [完整 CI 37662382268](https://github.com/veinyyxy/SpeedFeast_Backend_main/actions/runs/37662382268) 实际 success；app/lifecycle linux/amd64 容器隔离 smoke/bundle/pg_restore/Python/compiler 通过。lifecycle 合成五表结构不读取、上传或批准私有 baseline；CLI 写 root 仍 disabled。app health200/无数据库 ready503 不等于租户就绪。

PG16.14 Debian包装版本固定解析，lockfile范围内修复六项npm生产依赖advisory，新audit报告0、完整在线CI通过；不声明OS漏洞已清零。新 build-only workflow 无 AWS/OIDC/registry权限，精确镜像 tar＋小收据短保留一天，前两次失败记录保留。

独立手动 `.github/workflows/backend-reviewed-ecr-publish.yml` 与 `scripts/publication/` 验证成功run/artifact pins、ZIP/receipt/checksums、loaded image config，再获取30分钟OIDC凭据并推准确immutable tags；实际ECR manifest digest和自动BASIC scan/HIGH-CRITICAL gate独立回读，不rebuild/overwrite/delete或触发ECS。8项定向门禁测试/JS/Python语法、本地无云verify通过。发布工作流尚未实际运行。

`deployment/reviewed-ecr-publication.json` fresh文本SHA：`ce32e46450cd18f382d67de843eeaf208be9421beed80dc7cb94ed6d335abc10`；截止2026-10-08T17:40:00Z。绑定两个已checked image config/ZIP/receipt pins、执行器与Grant/Revoke模板；text hash采用UTF-8 LF规范化，artifact bytes SHA不规范化。

待确认范围：Source新栈 `techlong-sandbox-github-image-publication` 创建专用 publisher role＋managed boundary两IAM资源，复用现有OIDC，不改production角色/历史边界。main全ref trust不是AWS按workflow隔离；双policy仅ca-central-1 exact sandbox repository ECR上传/读扫描，固定截止。Source创建disable-rollback/Retain，成功或失败后立即独立Source应用Locked Revoke并回读boundary/inline/trust，保留资源/镜像，不自动重试。

只读AWS证明现有 `techlong-sandbox-speedfeast` IMMUTABLE/scanOnPush/BASIC，现有production发布role只允许另一个仓库；新role/boundary/stack absent，sandbox Cell MISSING。没有AWS/Neon/source PG15写入、ECRpush、paid Cell或Worker运行。预算仍50USD/月；ECR扫描/费用、ECS/数据库/网络/生产root不能由镜像构建成功推断。见 [完整证据和准确确认范围](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2f2-cloud-images.md)。以下记录保留历史状态。

2026-10-07 F2f 第一批完成代码和真实本地 PG16 验证；镜像候选尚未构建，本机无 Docker/WSL。生产 admission/CLI 写 root、真实 RDS/ECS/镜像发布仍未启用。下一批先取得容器构建条件，再补容器/compiler/digest readback 和 production root。以下记录保留历史状态。

## F2f 第一批：RDS owned-session、组合 verify 与 v2 receipt

`tenant_rds_sessions.js` 独立 prepared AWS Secret source 为准确 ARN/AWSCURRENT/严格 JSON keys，fixed pg endpoint/5432/数据库/role/CA/servername/timeout，不传 connectionString，不读 .env 或用通用 pool。Client actual PG16.14/TLS/用户/数据库/read-only identity 回读、取消关闭所有本任务自有连接、bounded end 与诊断脱敏；凭据尽量释放但不保证内存擦除。`createPreparedRdsTaskComposition` 先检查进程内 compiler brand，再读 image pinned CA、构造 sources/完整 SQL/app/cleanup composition；构造不执行云或 DB API。旧默认 factory/命令仍 inspect/legacy cleanup-only destroy。

composition 单独 `taskService` 在首轮 verify 后实际激活/app TLS 登录；已 verified active 库固定 schema/ACL/登录复验，不重新要求业务零行或覆盖 entitlement。新 v2 verify 输出携带三键 applicationAccess proof，legacy SQL-only service 不放宽。`tenant_lifecycle_prepared.js` receipt runner 先准确目标/协议/readExisting，已有回执不构造 execution sources；成功后 immutable publish/准确响应丢失恢复。CLI main 只 check-bundle；生产 admission/authority/env/deadline/artifact source/固定 task-definition root 仍待下一批，不靠 env flag 打开。

v2 publisher/平台显式 v2 reader 不交叉接受 v1/v2，SQL-only/false/额外 proof 拒绝，v1 不能附 proof 冒充真实登录；平台 mutation/Guarded evidence 保留严格 proof，默认 Worker仍 disabled。旧受批 transport key v1 形状/旧对象/IAM 不自动更改。SQL verified、databaseLoginVerified、HTTP/tenant ready 是不同证据。

真实 startup search_path=pg_catalog 暴露 journal constraintdef 文本限定不稳定；`tenant_journal_catalog.js` 在 durable management transactions 之间独立 READ ONLY/SET LOCAL pg_catalog,public，保留全部 v1/v2/cleanup pins，恢复借用 session GUC，不松开结构/ACL 校验、不更新旧表。

`Dockerfile.lifecycle` 候选为 pinned Node24.18.0/PG16.14、linux/amd64 pg_restore+同 pinned stage libpq、Python3、非 root、固定 bundle/SQL check、无 baseline/Secret/HTTP，默认只 check-bundle。尚无实际 Docker 构建/Linux动态库/compiler/image digest 证据。

AWS公开 global-bundle.pem 独立 HTTPS 下载到 `F:/ChatGPT_workshop/techlong-rds-truststore-20261007-f2f.pem`，169984 bytes，新 SHA `fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c`；111 个有效自签 Amazon RDS roots，包括 ca-central-1 三 G1 roots。新 loader/三个候选 Dockerfile/旧 migration shell 的 byte pin同步为审阅值；历史旧 e5bb pin记录保留，现有线上 images/系统truststore/RDS不更新。下次 bytes改变仍fail closed。参考 [AWS RDS CA 官方下载与 root说明](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)、[node-postgres URL/ssl override说明](https://node-postgres.com/features/ssl)。

最终目录 `F:/ChatGPT_workshop/techlong-pg16-prepared-rds-task-20261007-f2f4`；sessions receipt SHA `7960a3c9cda002af640ecac4bad465d73f6861ece765d37b0664045f6111112c`，`PREPARED_RDS_SOURCE_TASK_REAL_PG16_VERIFIED`。actualPreparedFactoryUsed/pinnedOfficialTrustStoreVerified=true：真实 SQL/实际TLS应用登录、v2本地immutable receipt响应丢失恢复/无provider replay、业务修改后active verify保留、owned cancellation、accurate cleanup、独立psql终态核验。AWS SDK/传输/storage明确是本地依赖替身；localTransportOverride=true、rdsEndpointVerified/rdsCertificateVerified=false，不能当AWS在线证明。平台独立validator/hash读取真实task-4 bytes，SHA `f3339ef910cdcb6ca6786d997222f1c47d898d8dc3bc61b2517ab4f8ed533f39`。

97 项 backend Node、28 项 Python、64 项平台测试、两仓类型/定向lint、migration shell语法通过；四个本阶段实例独立pg_ctl停止，失败/成功目录保留，私有证书/archive/SQL/key/cluster/完整receipt不提交。只删除owned local test DB/role，原OID不可恢复，永久记录保留；用户无关VS Code设置不提交。无源PG15/AWS/Neon写入、baseline批准/上传、paid Cell或Worker/ECS运行。[完整证据与下一批](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2f-rds-task.md)。

2026-10-07 F2e 完成：单独 prepared 应用最小授权、实际 TLS 数据库登录和对应的安全退役清理；默认 Worker/旧生产 CLI 不启用。下一步 F2f：固定 RDS owned-session factory、应用登录 source、SQL verify/activation 的 CLI/receipt/幂等恢复和镜像接线。以下记录保留历史状态。

## F2e：固定授权、数据库登录与准确退役

`tenant_application_access.js` 单独 `applicationAccess.activate(exactVerifyTask)` 要求 immutable prepare-v2 reservation、双 OID/ownership/完整 provision fence、准确 SQL verified marker、固定 baseline 和 migrated catalog pin `a1df988bfa23beca2f8c241872d00913205f1b9348ce14ad800d4d634d835263`。policy `speedfeast-application-access/v1` 仅准确 DB CONNECT/public USAGE/73 表 DML/sequences USAGE；无 DDL/TEMP/TRUNCATE/grant option/default grants/ownership。函数保留准确审阅 PUBLIC EXECUTE。授权/LOGIN 原子提交，active replay 完整 schema/ACL 只读复验；再用同一 Secret 的 URL 实际 TLS 登录、核对 server/datOid/role、逐表与 singleton 只读访问，管理 fence 最后回读。登录失败不误报 ready，不隐式撤销已提交授权，诊断脱敏。

激活前只读核验应用 role 对所有其他 connectable databases 无 CONNECT，未硬化的 Cell 拒绝，不自动跨库 revoke。fresh local fixture 显式硬化 postgres/template1/cell_admin；真实 RDS/Cell 必须单独 fresh SHA 审阅。PUBLIC grant 会作用于新 role，不能用单 role REVOKE 当作隔离。[PG16 GRANT](https://www.postgresql.org/docs/16/sql-grant.html)。

prepared composition 接独立编译 `PostgresTenantApplicationCleanupProvider`，默认旧 cleanup 仍 NOLOGIN/owner-only，boolean 不能放宽。active cleanup 先精确 schema ACL 回读，然后永久 destroying claim；管理事务 NOLOGIN/撤销准确 DB CONNECT/ALLOW_CONNECTIONS false。现有准确 datOid 会话返回 `TENANT_APPLICATION_SESSIONS_ACTIVE`，调用方关闭 pool 后恢复同一 cleanup fence，不 FORCE/terminate/wildcard/ownership cascade。原 journal 无新升级，双 OID/tombstone/后继 generation/旧 replay 保留 F2d 逻辑；retiring 也允许尚未激活的 SQL 状态。[PG16 ALLOW_CONNECTIONS](https://www.postgresql.org/docs/16/sql-alterdatabase.html)。

最终真实目录 `F:/ChatGPT_workshop/techlong-pg16-application-access-20261007-f2e4`；access receipt SHA `f7d34f3f883cc70ec8321550add7801e1e37fcc8a5da93018e32ad55c11246aa`，结果 `APPLICATION_ACCESS_RETIREMENT_REAL_PG16_VERIFIED`。非 superuser/TLS 实测未激活登录拒绝、其他 DB CONNECT 开放拒绝、部分授权 rollback、COMMIT 响应丢失恢复、真实登录与只读 replay、业务 UPDATE rollback、DDL/TRUNCATE/SET ROLE/CREATE DATABASE/TEMP/跨库拒绝、额外 ACL 在 claim 前拒绝、退役保留旧会话/阻止重新激活、关闭后准确 cleanup、新 generation/旧 replay 与独立只读 psql。第一代测试 DB/role 准确删除，不可恢复原 OID；永久记录/candidate 保留，第二代停止实例中的证据不删除。

另一个 fresh 实例 `F:/ChatGPT_workshop/techlong-pg16-lifecycle-cleanup-20261007-f2e-regression` 完整回归 F2d partial prepare/SQL chain/NoLOGIN cleanup/DROP 和 terminal COMMIT 响应丢失/后继 generation/旧 replay。75 项 Node、28 项 Python 与 typecheck 通过，五实例独立 pg_ctl status 停止。f2e1 固定 pin 校准、f2e2/3 退役后 activation 前置检查失败均保留。私有 archive/catalog/manifest/TLS keys/cluster/原始 receipt 不入 Git。

没有源 PG15/AWS/Neon 写入、baseline 生产批准/发布、paid Cell、ECS/Worker 运行。SQL verified、databaseLoginVerified、HTTP ready 是不同证据；默认 CLI 不能直接重放 SQL verify 到 active 业务库。50 USD/月不代替云执行批准。[完整证据与下一步](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2e-application-access.md)。

2026-10-07 F2d 已完成 prepared service、准确部分恢复、NoLOGIN 正常 cleanup 与新 generation 释放的真实闭环。应用授权/LOGIN/退役、RDS session factory/CLI/receipt/镜像仍待接线，runtime 和生产 baseline 批准保持 false。以下记录保留当时状态。

## F2d：显式版本与正常 cleanup

真实 PG16 INSERT 证明旧 cleanup registry 按 stable_identity 截断约束 marker，与 parsed task 的独立 hash_prefix 不符，返回 23514/cleanup_ck；不是 IAM/MFA 拦截。旧 registry/SQL/默认 production CLI 和原 prepare records 保留。新增 `tenant_normal_cleanup_journal.sql`：准确 hash_prefix/provision/cleanup fences、database/role OID、FK、不可逆 destroying/destroyed；flag 只能在旧准确 OID absent 后推进。REFERENCES 是显式父表 FK 依赖。`tenant_prepare_release_gate_v2.sql` 只显式调整两项 active index/table comment；prepare v1 默认指纹仍保留，v2 必须匹配所有旧 destroyed tombstone 才允许更大同身份 generation 复用命名空间，不复位旧行或自动升级云端。

新 `tenant_prepared_composition.js` 的 branded SQL port/service 接通既有三个 SQL provider 与 `tenant_normal_cleanup_provider.js`。完整 Secret callback 仅向数据库模块交付 URL；session source 生命周期由可信 caller 管理，普通 diagnostics 脱敏。独立 prepared service 从准确 journal/guard/OID 恢复 partial prepare；旧 service 拒绝不放宽。marker replay 仍调用真实 provider 校验，管理锁下核对 v2 journal/cleanup claim/target backend OID；不支持 epoch 自动采用。正常清理 record-first、database-first、role/terminal tombstone 一事务；无 FORCE/wildcard/ownership cascade。terminal replay 仅验证旧 OID absent，已创建的新 generation 名字不会被误删。

v2 prepare catalog SHA `7d08fae04b5e77a55085ccf4b4e06d44fa41a49e1dcc3630673fa31535113612`，normal cleanup SHA `847a45554decbb5cb951d58fa290d2991d749e9b5b9fc8a0b21772f40c952f24`。v1 指纹 `437c901ffaa790c57318f7de874567ae80993becd6dc0430b0911b734860c7da` 不被替换为宽松规则；显式版本选择不受 env 控制。未来实际安装必须 fresh SHA 审阅并前后完整回读。

最终目录 `F:/ChatGPT_workshop/techlong-pg16-lifecycle-cleanup-20261007-f2d4`，收据 SHA `5b1d172de6496adb54494f42459d4cc95a6393d7a03d6d4e5ecc8bf969a8419d`，结果 `PREPARED_COMPOSITION_CLEANUP_REAL_PG16_VERIFIED`。非 superuser/TLS 实测 partial CREATE 恢复、完整 service SQL 链和 replay 校验、未释放 generation 拒绝、DROP DATABASE/terminal COMMIT 响应丢失恢复、cleanup claim 阻止旧 provision、原 prepare row 保留、新 generation 准确新 OID、旧 cleanup replay 保留新数据库、不同 cleanup epoch 拒绝及独立 readonly psql/终态保护。第一代本地测试 database/role 已准确删除，原 OID 不可还原；源 archive/记录保留，第二代仍为隔离证据且服务停止，无开发库/云删除。

70 项 Node 新旧相邻回归、28 项 Python 严格校验和 backend typecheck 通过。四个本轮实例独立 pg_ctl status 证明停止，首次 REFERENCES 缺失失败与后续校准/成功目录全部保留；私有 files 不入 Git。当前仅支持 NoLOGIN/owner-only SQL 清理，不推断未来已登录用户的退役权限；下一批应用授权/LOGIN/真实登录+清理策略、RDS owned-session factory/CLI/receipt/镜像。默认 CLI 仍 inspect/legacy cleanup-only destroy，所有 runtime 门禁 false，没有 AWS/Neon/source PG15 写入或 paid Cell。 [完整证据及后续边界](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2d-prepared-cleanup.md)。

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
