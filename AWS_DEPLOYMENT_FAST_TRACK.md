# AWS 自动部署最快交付：服务端继续位置

2026-10-05 用户要求以单租户真实部署闭环为优先，取消原最低费用优先策略；新预算目标为 **50 USD/月**。完整方案由 TechlongSoftware 的 `docs/aws-auto-deployment-fast-track.md` 维护，服务端与平台仍保持独立仓库，直接提交/推送 main。

## F3b3：Neon兼容恢复入口已准备，仍需另批密码原值传输范围

2026-10-08 Winnipeg。官方Neon文档明确SQL密码不支持预哈希形式，原SCRAM入口存在托管兼容性差异；原错误没有SQLSTATE，不能声称唯一根因已证明。平台独立恢复module/CLI绑定原失败回执3096211...和两准确已存Secret ARN/UUID/AWSCURRENT，仅拟经认证TLS各一次原密码+LOGIN、一个本地事务，保持forward_ddl=on，不生成密码/新建或写Secret/改标签或IAM。原9文件binding3ec...、所有旧槽位保留，新恢复slot空；明确服务端/提供者日志风险、跨系统非原子和不自动down/delete/重试，实际写入仍fresh SHA单独批准。

23:35UTC真实只读两角色仍NOLOGIN、roleState1528e1e.../preserved993506.../原seal与业务不变；两准确Secret仍唯一初始版本/严格载荷正确，Source有效，未做AWS/Neon写入或受限认证。18项定向/type/lint/语法通过；[PG18云端run37860578505](https://github.com/veinyyxy/TechlongSoftware/actions/runs/37860578505) headdf18bee/attempt1 success，共32组（3新原密码SQL/真实认证/失COMMIT只读恢复），两DB drop/容器stop/准确artifact独立核验通过；Neon hook/AWS仍mock，非托管提交证明。清单SHA `3610895cfb3b42e14929302105c4beb127c26bf74f42deb32734bf9d86e4918a`，到2026-10-09 00:35:05.741UTC过期，未批准/执行。50USD月目标/两收费Secret约0.80USD月基础仍不变；runtime/Cell/ECS关闭。本仓仅同步文档，生产源码和镜像不改。[独立恢复清单与风险](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-neon-credential-recovery.md)。以下保留历史。

## F3b3：AWS两Secret已创建，Neon LOGIN未证明提交，禁止重放

2026-10-08 Winnipeg。用户批准85b500...后一次Run创建/读回两准确Secret/AWSCURRENT/Approval标签/完整载荷：readonly-v3-AWZoLG，drain-control-QDFwQ9，UUID仍3f8047d4.../72eb93b3...。两角色SCRAM/LOGIN语句在事务内执行和校验后，DATABASE_COMMIT抛错未确认，submission SHA `3096211ad3a9edc0621c0ef8f6abab677e2ebf5685f034ec8205cebdfe6fe0fb`。23:16:16/23:17:23UTC两次独立Inspect仍NOLOGIN、原roleState1528e1e.../preserved993506.../seal和业务保持，credentialReady=false；文件SHA5c305770.../d44a8754...。不是成功激活/部署完成，未做受限角色认证，不能证明密码或Neon控制面绝对未变。

credential slot永久消费，旧slot保留，没有Run重试/改密码/重造Secret/down/delete、IAM/Cell/ECS/Lambda变更或runtime启用；两Secret仍保留收费，基础约0.80USD/月加请求相关费用，50USD目标不变。只读provider检查9ce8c5f...显示pooler=true、neon.forward_ddl=on；官方密码DDL PRE_COMMIT控制面hook是排查线索，原SQLSTATE未记录，具体原因未确证。新增独立只读脚本，不改原9文件binding3ec...；下一阶段托管提交诊断及复用现有准确Secret版本的恢复设计，所有新写另fresh批准，禁止关闭forward_ddl绕过/原bootstrap重放。本仓仅文档同步，生产源码/镜像未改变。[真实部分状态与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-control-credentials-partial.md)。以下保留历史。

## F3b3：Secret-first/SCRAM控制凭据审批入口已验证，未执行

2026-10-08 Winnipeg。平台独立新credential slot/Review/单次两Secret先存+一个事务SCRAM密码/LOGIN/只读Inspect实现；旧角色安装代码/SQL/已消费slot不改。每角色32随机字节密码，无生产密码/URL/SecretString/verifier本地持久化，DDL不发明文密码，但不能保证JS清零或PG服务端不记录verifier。LOGIN将真正开启受限认证能力（drain原列写不是纯读）；不追加GRANT、IAM、rotation/replica/policy/Put/Delete、Lambda/Worker/runtime/Cell。

67项定向/type/lint/语法/build通过；最终 [PG18 run37853428469](https://github.com/veinyyxy/TechlongSoftware/actions/runs/37853428469) headdf9a135/attempt1 success/29组，两自有DB drop/容器stop与artifact独立verification `8a6873b703ad12be193f2d011b35943d584b4e71c37b5c6368d8e94d8e07d621`。SCRAM LOGIN/正确错误密码/失COMMIT只读恢复是真PG；AWS Secret明确mock，非实机写证明。Source当前有效，两Secret/新IAM/Lambda ABSENT；原NeonNOLOGIN状态1528e1e...不变，六相关权限只读模拟allowed，但不是实际创建保证。

最终fresh清单 SHA `85b500511452328329159ebe0ce13ea5aeeaa36dd9cb6aef64bd19f103d27a54`，文件f8cf6afa...，code3ec561f3...，2026-10-08 23:26:12.968UTC过期，**尚未批准/执行**。仅两准确Secret（readonly-v3及drain-control）初始版本/标签/default AWS-managed key，再两现有角色原子设置密码/LOGIN；接受跨服务非原子/失败可能留收费Secret或LOGIN角色，不自动delete/down/reset/重试。ca-central-1官方价表9bea1ef2...约0.80USD/月基础+请求/KMS适用费用/税费，50USD/月目标非cap。旧slot全部保留、新slot空，无生产密码生成/SecretString读取/Neon或AWS写。本仓仅文档同步；IAM/Lambda/authority仍后继单独批准。[具体清单与恢复入口](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-control-credentials.md)。以下保留历史。

## F3b3：Neon两NOLOGIN控制角色已安装并两次独立回读

2026-10-08 Winnipeg。用户批准4ef39a5995c8a0d394e1cbb72b2c3e51d8588bd86e8b75e3d6287ba138171cac后，平台原code03a91abc/SQL7fc82e...单事务一次COMMIT确认；21:27:03.106/21:27:38.185UTC两次独立Serializable READ ONLY Deferrable回读完整状态一致。techlong_cell_cleanup_reader/drain均NOLOGIN/NOINHERIT/非管理员，无owner上行membership，reader八表SELECT/无列写，drain四表SELECT/准确20项列权限；创建者neondb_owner ADMIN=true/SET=false/INHERIT=false符合已批scope。原seal=true/revision2/完整证书dc093614.../原业务/其余权限保持，preserved SHA `993506a66f586d9ad447b77769769cbf372dee9be9a30cc556af9d9de00426fa` 未变。

poststate SHA `1528e1e2888bb191200d8bc2224318512cfa63f5aaa138eb324870674f3fe0ef`，submission `229e15ec8e7ddf045dbb767a156429beaa5930549a930f231e5bdf72a6f60ab7`，两独立readback文件SHA同为 `e995627f19eb029c88ec0b474cdaaed240264ff22d3507c89aed329f9830757f`（稳定内容不含时间，不同时间observation另有不同SHA）。role-install slot永久消费，原schema/register两slot保留，禁止Run/down/reset/GRANT重放。本轮没有设置密码、LOGIN/Secret、AWS调用或runtime启用；50USD/月目标不变。下一批仅准备角色LOGIN/随机凭据/两准确Secret的具体scope供fresh SHA批准，随后IAM/Lambda/authority另批，自动部署仍未整体上线。本仓仅文档同步，生产源码/镜像未改变。[实际安装证据与下一阶段](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-neon-control-roles-installed.md)。以下保留历史。

## F3b3：第一批NOLOGIN控制角色安装入口已验证，等待新SHA确认

2026-10-08 Winnipeg。平台新增独立角色审阅/单事务一次性执行/提交不明只读恢复入口，不改原schema/install/register代码和slot。两个准确角色techlong_cell_cleanup_reader/techlong_cell_drain初始NOLOGIN/NOINHERIT/非admin；reader八表SELECT，drain四表SELECT、admission七列UPDATE、jobs十一列INSERT、行锁timestamp UPDATE。列能力不是单行/单环境限制，也不是纯读；创建者自动获得ADMIN=true/SET=false/INHERIT=false，须随具体scope批准。密码/LOGIN/Secrets/AWS/runtime均不在本批。

57项定向/type/lint/语法/build通过；[真实PG18 run37842882331](https://github.com/veinyyxy/TechlongSoftware/actions/runs/37842882331)/head8c5080e/attempt1 success、26组证明，覆盖本协议非super CREATEROLE、完整有效权限、失COMMIT后独立回读、不重放及额外列写拒绝；两自有DB drop/容器stop与artifact独立verification SHA `d47e14f4955360e4959664706d7d148bca826314ef873bb54628dc249534213c`。四个失败试验artifact保留；修复序列谓词类型保护/负测试search_path，不扩权限；AWS/DDB/删除仍mock。

Neon最终只读role/别名0、原seal一致、role-install slot空；Source只读新IAM两角色/两Secret/v3 Lambda仍ABSENT。fresh清单 SHA `4ef39a5995c8a0d394e1cbb72b2c3e51d8588bd86e8b75e3d6287ba138171cac`、文件SHA551c2c95...、code binding03a91abc...，过期2026-10-08 21:55:47.776UTC，尚未批准/执行。确认后仅两NOLOGIN角色/GRANT及独立回读，接受短暂写锁/提交后不自动down/永久slot无复位重试；本批无需AWS/MFA。下一批LOGIN/随机凭据/两个Secret再单独scope，随后IAM/Lambda/authority。没有Neon/AWS写入，自动部署/Worker关闭，50USD/月目标不变。本仓只同步文档，生产源码/镜像不改。[完整安装清单与恢复入口](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-control-role-installation.md)。以下保留历史。

## F3b3：平台持久v3执行入口/新包与最小权限候选完成，未安装

2026-10-08 Winnipeg。平台独立v3完整authority解码/前驱原子读/一次CAS安装器、永久intent/receipt journal、专属root/SDK/Lambda3完成，完整已批准证书pin与raw witness入新hash；旧v2不桥接，只有CAS赢家一次准确STANDARD DeleteStack能力，失slot/重启/失响应只读恢复，无reset/down/重试。source补RLS隐藏行、列级写与非trigger definer执行拒绝，默认Worker不启用。45项定向、137项相邻回归（有重叠）/type/lint/语法/build通过；[PG18 run37829262726](https://github.com/veinyyxy/TechlongSoftware/actions/runs/37829262726) head3477818/attempt1 success/23组证明，两个CI自有DB drop/容器stop独立核验；AWS/DDB/actuator明确mock，不是云删除。verification SHA `655fdd4e59078d75953b040ff8d8e893c05dc63d47e54915a0841488142a7f4b`。

最终新ZIP SHA `921046b3bddf8cb5c399b4ebad5c1f99957215b412d94fd13366b24f466d8bb7`、review86597e1d...，自包含/重复hash/ZIP回读/无凭据启动通过，未上传/安装；旧包和app/lifecycle镜像不改。Neon真实只读roles0/owner可CREATEROLE/PUBLIC非trigger definer0，源证书/guard完整；最小两角色SQL SHA7fc82e...仅未注册NOLOGIN候选，reader八表SELECT，writer包含明确需审的admission/job列权限及行锁用timestamp UPDATE，不是行过滤/纯读能力。Source只读两IAM角色/两Secret/新Lambda-v3均ABSENT，现有authority表ACTIVE/PAY_PER_REQUEST，库存SHA `b5ca5f323bc728e6411669491054e2beafc36584f4e05c8f1a0c18831eba4634`。

下一阶段具体DB角色/GRANT/LOGIN凭据/Secrets/IAM/boundary/Lambda/authority可执行安装清单，按fresh SHA分别确认；当前无新增权限/Neon/AWS写，runtime关闭，50USD/月目标不变，两Neon固定槽位永久保留不重放。本仓仅同步文档，生产源码/镜像不变。[完整v3入口与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-durable-executor-v3.md)。以下保留历史。

## F3b3：准确旧计划已永久登记密封，自动部署运行时仍关闭

2026-10-08 Winnipeg。用户批准1fba989e681c6e7bb0c71178adfde6686f618359ad9e422db549b7b038aab333后，平台按原受审代码仅执行一次准确证书INSERT/内部fence finalize，COMMIT确认、新连接独立回读及另一次VerifyRegistration均通过；registry1、fence sealed=true/revision2、sealed_at1791480771883。两份完整证书canonical SHA `dc093614188a8f0a086b4fc6a7e251c43312495a60db2efffc654cf3d48b066f` 一致，protection SHA41eea5ac8b64801144fa568dce2b42d5dcb350a520a82df91f973c23bedab168不变。原行/plan/实例pending/订阅active/旧trigger/角色未变，拟议控制角色仍0，未改AWS、授权或启用runtime。

submission SHA `b805b34f8186c5bccede66cefb5d05e0b39d754368da6459e2d399588e29564d`，独立readback SHA `d7f609f0e7c341c8cb0e847f2fab90f8749292ab9265af654159e655ad2d712a`，另次Verify SHA `2b8b75e2fa4d20a17c5d9cad8561d1a6f1e9321cb056b6b9f5c4786f8ce3651e`。install/register两个固定槽位均永久占用，禁止Run/down/复位或刷新清单重放；后续source expected完整证书必须来自批准提交后的私有独立receipt pin，不能从event/任意DB行生成。下一阶段v3持久authority/CAS/永久journal/独立root/新包及最小DB角色/Secret精确审批范围，实际新权限/云部署仍单独批准；50USD/月目标/旧Budget和镜像不变。本仓仅同步记录，生产代码不动。[准确密封登记与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-neon-plan-sealed.md)。以下保留历史。

## F3b3：Neon保护schema实际安装完成，准确旧计划仍未登记

2026-10-08 Winnipeg。用户批准安装清单ce844c9096de5c71cf3d3447916143260d336292180dbf2193f3b256d67fb36b后，平台按原554b125/code38c479及C088 SQL执行一次，COMMIT确认、新连接独立回读及另一次VerifyInstall均通过。实际两表/八函数/十六Always触发器/一条未密封内部fence，registry0/fence revision0，protection SHA `41eea5ac8b64801144fa568dce2b42d5dcb350a520a82df91f973c23bedab168`；原行、实例pending/订阅active、旧trigger与现有角色未改变，未创建角色或授权。install固定槽位永久占用，禁止再次RunInstall/自动down或复位。submission SHA `f3e3f493f4c7173b6237695696418ba52f2d3c293b5fe19d626bc545e32dc371`，独立readback SHA `2f99cc6974a27799023a1d72fd533bc97de738527aa6c8bd679649b2839f6726`，另次Verify SHA `a78d2fc1b4ba374ea09a0dbd7438aa7d2e4ab34d047c89ce57d45638a023ea5b`。

已仅只读生成后继登记清单SHA `1fba989e681c6e7bb0c71178adfde6686f618359ad9e422db549b7b038aab333`，过期2026-10-08 18:21:21UTC，尚未批准/执行，登记槽位空；下一步仅准确单行永久证书登记及fence finalize，必须具体新SHA批准，安装批准不外延。源schema2门禁/source-v3/Worker/runtime未放宽或启用，AWS/镜像/Lambda包/旧Budget不动，50USD/月目标不变。本仓仅同步记录，无服务端生产代码改变。[真实安装与登记继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-neon-schema-installed.md)。以下保留历史。

## F3b3：平台Neon管理审批入口完成，schema安装待具体确认

2026-10-08 Winnipeg。平台代码554b125实现独立Review/Run/Verify Install与Registration，准确目标/代码/完整prestate SHA及一小时审批窗口；RW事务短暂锁准确表、二次读比对后才领取固定一次性槽位，失败不复位/重试，未知COMMIT只读恢复，不自动down。32项定向/type/lint/语法/AST/build通过。[真实PG18 run37813739467](https://github.com/veinyyxy/TechlongSoftware/actions/runs/37813739467) attempt1/head554b125 success，19组证明，两隔离CI数据库均drop、容器stop独立核验，覆盖真实安装、准确登记和丢失commit响应恢复；verification SHA `9cbc3261d32baf5ad062b2c582c03e83108cba3c5601ac64a3f2b854091dad32`。

实际Neon仅TLS/Serializable只读：PG18.6、13表owner neondb_owner、十个引用闭包、新对象0/拟议reader-writer-registrar角色0；原计划planned/plan_only、九类执行引用0、实例pending/订阅active与旧trigger保留。最终仅安装清单SHA `ce844c9096de5c71cf3d3447916143260d336292180dbf2193f3b256d67fb36b`，过期2026-10-08 18:07:22UTC，未批准/执行；scope仅两表/八函数/十六Always trigger/一条未密封内部fence，不登记、授权、改业务/旧trigger或AWS。install/register固定槽位均空；过期只读刷新后再明确确认。实际单行登记、最小角色/Secrets、v3持久authority/journal/root及云资源各另批，runtime仍关闭/50USD目标不变。本仓仅同步文档，生产代码/镜像/旧slot不变。[完整管理与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-neon-management.md)。以下保留历史。

## F3b3：平台v3新鲜证据与完整候选/计划绑定完成，未云启用

2026-10-08 Winnipeg。平台实现独立v3 authority/deletion evidence适配，严格30秒时钟、到期和准确admission lineage、五类真实零集合、进程内live provenance及第二次读取完整state漂移核对。完整证书/raw witness进入新authority候选和删除plan SHA，不降级schema2，固定专属Executor身份、不开放override。候选安装许可与plan mutation/runtime许可均false；没有v3持久authority/CAS/journal/root安装或DeleteStack执行方法，旧Janitor/v2 core/默认Worker保持不变。

[真实PG18 run37809750133](https://github.com/veinyyxy/TechlongSoftware/actions/runs/37809750133)，head `e4a615b69223b09a7c5e2595fffc39e06d00d26a`、attempt1 success、16组证明，实际受限cleanup_reader证明future阻止candidate及全证书/raw state绑定新plan；CI Stack明确为合成fixture，不是AWS删除验收。25项隔离/v3定向与173项相邻回归/type/lint/AST/build通过。独立raw artifact digest与数据库drop/容器stop已核对，verification SHA `cc095754a758bbca781bc24eff5f8fc48d75a0b669b70d4a55e0855662656585`。原SQL C088 SHA未改，Neon未连接/安装/登记，AWS未变更，新Lambda包和app/lifecycle镜像未重建。

下一小阶段生产密封安装/登记审批入口及准确Neon schema/owner/最小角色只读preflight；v3持久authority/一次性journal/独立root仍待接通，不能安装旧v2包当v3桥。数据库安装/单行登记与云IAM/资源均按fresh具体范围分别确认，50USD/月目标、旧Budget和所有历史记录/slot保留。本仓生产代码与source19cc双镜像不动，仅同步文档；默认Git授权直接提交推送main。[完整证据与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-evidence-v3.md)。以下保留历史。

## F3b3：平台PG18.6真实CI与独立ownership source v3完成，未安装

2026-10-08 Winnipeg。[PG18 schema run37800779231](https://github.com/veinyyxy/TechlongSoftware/actions/runs/37800779231) head9a31c7a/11组，[source-v3 run37804488475](https://github.com/veinyyxy/TechlongSoftware/actions/runs/37804488475) headf83d1fb/14组，均attempt1 success、固定官方18.6-alpine镜像digest；独立下载校验raw ZIP/GitHub digest、report/receipt和临时DB drop/容器stop。a2独立verification SHA `f28fbe6d3a9707e547f84b3f7be7dbefe0b6ea5ad4f23db2725a93f8f8391340`；仅GitHub自有临时服务与合成数据，无AWS/Neon凭据或写入。复用原SQL候选C088 SHA未变，不再把PG16当PG18证明；CI不是Neon安装后在线proof。

平台新source v3只有只读Serializable/deferrable入口，固定cleanup_reader/无owner或write资格、完整预期证书/原件/永久fence与独立inline catalog重算，拒绝helper替换且不执行该helper；raw witness和所有分类集合进新hash，future部署/资源/容量/调度保持可见。152项相邻回归/type/lint/build通过；未接旧schema2/root、未Neon schema/登记或Worker启用，下一步v3 freshness/admission/authority/deletion适配。新安装/准确登记/IAM/云资源仍fresh范围各批批准，50USD目标不变；本仓只同步文档，source19cc镜像和生产代码不动。[完整证据与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-pg18-ownership-v3.md)。以下保留历史。

## F3b3：平台密封schema/永久引用guard候选完成，Neon仍未安装

2026-10-08 Winnipeg。未注册SQL候选SHA `c088d1a8c75705c88d3f2bfc38cc6070c731de4cac6cd891c91af821a4e3a57a`，两内部表/八函数/十六Always触发器，覆盖九类表十个旧deployment引用列及原行永久保留；内部fence真实revision更新防止旧RR/Serializable快照越过登记。完整列/约束/索引/trigger/function/RLS/owner与跨schema FK闭包指纹，不改旧immutable trigger，不自动注册migration。完整平台schema+合成数据的隔离PG16.14通过11组真实保护/并发/业务连续性证明，server已停止；最终报告SHA `d4ff47efc5a7744794e982a2398f57881dcdda1d63a70cbc08870d54895d9add`、stopped receipt SHA `a73f329395b542704582b184cc10db7ddbe9b5b5482de980dc13d5523b58acfd`。9项定向检查/type/lint通过。

Neon真实只读报告SHA `bbf6e8354d6efdda719176f2f3a85c1f1d13073f91a8c3cf84ccbfc1a1d0a7b8`：原行planned/plan_only/attempts0，十个FK闭包符合、新对象槽位0、原trigger启用；**实际版本18.6，PG16结果不是Neon运行证明**。未Neon/AWS写、生产登记、ownership source升级或Worker启用；下一步PG18隔离验证与独立版本化ownership proof，实际schema/准确登记/IAM/云部署仍分别按fresh具体scope批准。服务端本轮仅同步记录，复用本仓现有isolated fixture helper未修改，source19cc镜像及Lambda包保持原样。[完整候选与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-sealed-schema-candidate.md)。以下保留历史。

## F3b3：平台独立Executor v2代码与候选包完成，未安装

2026-10-08 Winnipeg。平台新core/root/SDK journal/Secret入口仅接受TechlongSandboxCellTtlExecutorRole，schema2删除计划SHA绑定完整role ARN和dedicated-cell-ttl-v2，旧Janitor schema1/PLAN_ONLY/IAM保持不变；持久化intent/receipt schema2拒绝旧记录，单次CAS赢家删除、失响应只读恢复。143项相邻回归/type/lint/build及自包含ZIP自检通过。新ZIP SHA `201775955cc3b80bdbabf89b84a163c174442c81f3a0f2ea48429d4333f5f23c`、报告SHA `ba1d328eb650f33e35eef239c7a8dfe7442efe963d7e74bee7c52d3b48d02331`，尚未上传/安装、非Linux/AWS proof。14:03Z Source真实只读核对新role ABSENT，证据SHA `e5390a8bf836a46d3e265040d74e258fa30c11118419cd947863c1e4ef16e5a5`；未创建资源/权限。

旧规划密封隔离协议具体化为append-only登记、原行/所有执行引用永久围栏、完整证书/新source schema3契约；未实现DDL/注册migration/新ownership adapter，当前严格零租户source及1/1门禁不改。下一小阶段准备未注册schema/永久guard与版本化证明，新Neon安装/准确登记/IAM/云部署仍各按fresh具体范围批准。服务端仅同步记录，生产代码/source19cc双镜像与旧发布slot不动，无AWS/Neon业务写、Lambda调用或Worker/Scheduler启用。[完整产物与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-dedicated-executor-v2.md)。以下保留历史。

## F3b3：旧计划与控制面只读审阅完成，独立executor身份待修订

2026-10-08 Winnipeg。准确旧dep_d00144511731f1c20991aa56 planned/plan_only/attempts0、无job/resource/capacity/schedule/step，但实例pending且订阅active；用户选择保留业务。Neon实际启用的trigger禁止修改environment_id，不能直接迁移或绕过。平台保存原行/业务状态/trigger私有证据并加入严格审阅器与密封非执行登记设计；review SHA `113f62e2dd5ee643466818d6ea100ff4539e12745c421d646724d214218112f6` 是设计hash、不是执行许可。现有零租户协议未改，activeTenant/nonterminalDeployment仍1/1，新schema/登记/协议候选均未安装；没有取消、暂停、删除或改订阅。

Source刷新后真实控制面只读报告SHA `f0c8fd4ccf68171dc24a2872bb71d648173fdc2bfa45979cda95797a89c484d0`：旧函数仍PLAN_ONLY，两新函数/DrainCoordinatorRole/两boundary/两Secret均ABSENT。关键发现Janitor boundary v2同时作为身份策略附加且无条件Deny变更，仅换boundary不能复用；原草案/产物保留不安装。推荐独立TechlongSandboxCellTtlExecutorRole，保留旧IAM与函数；当前core/Secret/executor artifact绑定旧Janitor，需要独立版本化精确入口和新产物。新候选role存在性尚未读取，不假定ABSENT。

6项定向审阅器、type/lint/AST通过；没有AWS/Neon写、Lambda调用、角色/Secret创建或镜像重建，Worker仍关闭。本次审阅切片完成，F3b3尚未整体完成；继续精确身份修订和密封隔离协议候选，新数据库/云安装仍具体scope及freshSHA单批。服务端仅同步记录，生产app/lifecycle源码与source19cc镜像不变。[完整证据与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b3-isolation-review.md)。以下保留历史。

## F3b2：平台draining/清理事件协调与独立Lambda候选完成

2026-10-07 Winnipeg。平台实际接通Neon admission writer、owned cleanup/rollback INSERT-only producer和六查询serializable snapshot，独立drain与F3b1 executor Lambda候选已自包含构建/ZIP字节回读/重复hash与无凭据启动自检；读写Secret及拟议DB角色分离，未安装。131项相邻清理、type/lint/build通过；Neon真正READ ONLY EXPLAIN验证SQL（无ANALYZE/无mutation），SQL SHA78ca4315bcfcd853030aa41c3dd76fbf92d91c3371ce34abba9f757d8bf05a92。

最终a5 artifact报告SHA `3e7ee33443b69a3e50aa5c49501e44f9e0a759e2bce26b5f02629ce9a0841615`；drain ZIP `5e9e7253e2666793fd7c981444255d8bec368049b7057bc039732fed4f6a5160`、executor ZIP `c08cd0618fa9116f97031bb9ed49fb726ebed1698eff4a82a470dc8b39cf2fd3`，私有F工作区，未上传。新函数/专属boundary/两DB角色与Secret及现有Janitor受限权限仅未授权资源草案，不替换旧PLAN_ONLY，不改共享七role boundary；authority writer/调度/真实云TTL仍未完成。

只读Neo库存环境准确402010193138/ca-central-1/cell-sandbox-1/open/live resource0；旧记录 `dep_d00144511731f1c20991aa56` planned/plan_only/cell-demo-1，owned resource0/active job0，未终结数量1，两拟议DB role不存在。旧记录保留、不自动取消/删除/忽略，它仍阻止严格零租户证明。下一F3b3准备旧计划最小处置review、控制DB角色/Secret/准确IAM/函数/调度安装材料，再按fresh范围批准；不能凭动态SHA自动授权。没有AWS/Neon写、付费Cell、镜像重建或Worker启用，服务端source19cc两镜像和已消费发布slot不重放，50USD目标不变。[完整产物、验证与边界](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b2-drain-coordinator.md)。以下保留历史。

## F3b1：平台Cell TTL持久化执行入口已准备，服务端镜像不重建

2026-10-07 Winnipeg。平台复用原严格Cell删除core，新增prepared一次性intent/immutable receipt执行入口和真实SDK组合，共用懒凭据、固定区域/忽略endpoint override、maxAttempts1；只准准确受审SHA，提交不确定/重启/并发走只读恢复，不再次DeleteStack。102项相邻清理与129项租户TTL/rollback主链、type/lint/build通过；生产runtime检查仍disabled/offline_only、50USD目标、cloudMutationPerformed/databaseAccessPerformed=false。

服务端app/lifecycle生产代码与此前source19cc两镜像不变，不重复构建/发布，不重放1ab永久消费slot；旧云PLAN_ONLY Janitor/Scheduler/Worker未启用，没有AWS/Neon/源PG写入或新权限/Cell。新DDB intent/receipt键仅准备，未授予/写入；代码测试不是线上TTL删除证明。下一步F3b2接自动drain/租户清理→强一致零租户→authority/plan的生产协调、Janitor artifact和准确权限/调度范围，实际安装/删除另批，F3未完成。[完整代码切片与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3b1-cell-ttl-execution.md)。以下保留历史。

## F3a2：新root双镜像已发布，立即撤权与独立回读完成

2026-10-07 Winnipeg / 10-08 UTC。用户批准新清单 `1ab97e7b380947662e54920a3150e4c314fd8d8f8a29c320a74f7abe46b51c6a` 后唯一RunReviewed成功：仅更新既有publisher role/boundary两资源，[Actions run37714817734](https://github.com/veinyyxy/SpeedFeast_Backend_main/actions/runs/37714817734) attempt1/head91cbf44 success，发布原候选run37702693753/source19cc3e096df4d37be0a6570ce3116d47c472ace2，不重建镜像。Source立即Revoke后独立准确template/inventory证明UPDATE_COMPLETE、Deny-all boundary/inline/trust、attached0、Locked/v6；窗口截止后再次Inspect仍Locked。

app tag `app-sha19cc3e096df4d37be0a6570ce3116d47c472ace2-r37702693753-a1`，registry digest `sha256:2af648ae122dad46dcba313481797a49766744c4de167d33642dba124908df07`，config `sha256:75140a5e88550b04f458e2aa2c1b6b7b4326dc1225e11d8491dc2f440ac63206`。lifecycle tag同source/run的 `lifecycle-` 前缀，registry digest `sha256:2ab7017dcebd64083e7804001685272a3a5461faa4b7a4bec37adab059980bb4`，config `sha256:8cd975a2f73c11e4363ef5fbf298416323f2723a24a68738e72dfdf273342d9e`。Source下载实际manifest/config bytes并计算SHA；两BASIC scan均COMPLETE/空finding，无报告HIGH/CRITICAL。原始GHA receipt SHA `a304540fe1a729c6ca8a80a69af27467cfa0feb24ebf2838293d0a2f79e6bb50` 与独立两组pin准确一致，不以config digest冒充registry digest。

实际CloudFormation在01:48:26Z删除旧policy v3（request603c1232-283a-44dd-b73d-46b4f66d2d90）、01:50:57Z删除v4（requestdf545569-bb21-4c9a-bf49-845d2a756c96）；us-east-1准确CloudTrail均为Source IAM user/userAgent cloudformation.amazonaws.com。这是已批准的版本清理副作用；写前v3/v4原文备份保留，云version ID不可恢复，不能把resourcesDeleted=false说成所有云历史仍在。当前版本v5/v6、default v6；role/policy本体及六份旧镜像保留，共八份镜像。Cell准确cluster仍MISSING。

私有执行slot `F:/ChatGPT_workshop/techlong-reviewed-ecr-republish-1ab97e7b3809` 已永久消费，summary SHA `ee71cd83a907844a57ec52d6bb8d0bbdf36adad0bca6a7bdd7356bf15b3ac4a3`；独立ECR bytes/scan报告 SHA `a62b3f2791f9586fe9123e8cfebb282b72510e506da6b1e70550499b7dd0d032`；中断后完整只读closure SHA `6f35d0027363a5e179205976a3c265c88c1e8e3bc2545c6510b89cc47c2182b3`。原件/备份/CloudTrail私有目录不提交，旧清单/template/slot不删除。9项publisher相邻回归再次通过，执行器完整CI37714234982及真实publish均success；不改本次批准manifest/执行器。

安装02:00Z/权限03:00Z窗口已过期，**不要RunReviewed、reset slot、复用批准或dispatch重试**；只读恢复用Inspect。未部署ECS/付费Cell、上传baseline、安装其他权限/authority、写Neon/源PG、启用Worker。下一代码切片优先owned-resource可执行TTL/失败清理，专属IAM/baseline/读cap/Budget/证书mTLS/DNS和实际Cell按新准确范围另批。50USD/月仍为目标、非硬限额；真实Fargate metadata/卷/RDS/lease/cleanup/HTTP ready待验收。[完整记录](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f3a2-ecr-published.md)。以下保留历史状态。

## F3a1：808批准尝试在云写入前停止，新解析修复清单待确认

2026-10-07 Winnipeg。唯一RunReviewed在候选expiry元数据检查line155退出，永久slot未创建、没有Grant/AWS写或GHA dispatch；Source独立Inspect仍UPDATE_COMPLETE/Locked/v4。原候选id/name/digest/source/run/expiry均未变，失败原因仅Invoke-RestMethod把expires_at自动解析为DateTime，与manifest String被判不等。

GitHub helper现用raw Invoke-WebRequest Content+ConvertFrom-Json -DateKind String，保留空204响应行为；实际两候选GET证明所有pin准确匹配。9项scope/历史/transport回归、typecheck/AST通过。新SHA `1ab97e7b380947662e54920a3150e4c314fd8d8f8a29c320a74f7abe46b51c6a` 与808严格保持同images/IAM templates/iamUpdate/installBy/expiry；只更新执行器hash/审阅时间和解析说明，必须新确认，不自动重跑。808原件保存history并校验旧SHA不变，两slot均未占用；原02:00Z安装cutoff/03:00Z权限expiry不延长。未部署ECS/上传baseline/改其他资源，publisher仍Locked。平台详情 `docs/aws-auto-deployment-fast-track-f3a1-timestamp-preflight-fix.md`。以下保留历史。

## F3a：在线只读preflight与仅新root镜像发布审阅完成

2026-10-07 Winnipeg / 10-08 UTC。实际Source53-read与补充检查确认Aurora16.14/db.serverless可用、Cell不存在、publisher仍Locked/v4；当前Janitor PLAN_ONLY/global schedule DISABLED、无Sandbox wildcard/trust store/hosted zone，baseline bucket缺失、lifecycle IAM缺admission/baseline、DDB读cap5、tagged Budget仍10USD，ELB service-linked role不存在。未做AWS写、角色登录、Lambda调用、Neon/源PG连接或付费部署；50USD目标未静默更新到云。

新script `inspect-checked-candidates.js` 已真实GET原始run37702693753/source19cc3e0两ZIP并核验原始receipt bytes/SHA256SUMS/OS self-check，私有目录 `F:/ChatGPT_workshop/techlong-f3-artifacts-20261008-a1`、报告SHA `a04520ddfe02c4f56d4192e422849aa7038cf0adf088cd4552a3d29ec7e88f5b`。无Docker load、registry digest或云发布证明；app/runtime生产源未变，不重复构建，原候选和旧ECR镜像保留。

fresh schema3发布清单SHA `8081815c08436a219d1701867bcaf9f16d19bfb0437c66270bee52822163a8c2`：只从default v4/库存v3-v4更新既有两IAM资源，GHA一次发布两source19cc固定tag并回读BASIC scan，成功/失败立即SourceRevoke/独立Locked；没有ECS/baseline/其他权限/资源创建或主动删除授权。明确接受CloudFormation可能清理旧非默认policy version（包括v3/v4）；写前备份所有原版本，不能恢复被删version ID。CLI Login自动刷新但外层session未独立保证。执行器已修正UTC String日期解析，备份后再检cutoff；slot/过期/失败均不自动重试。**未执行Grant、未dispatch，必须确认此新SHA。** installBy02:00Z（Winnipeg10月7日21:00），expires03:00Z（22:00）。已消费15d30原件移入history且旧SHA不变，ce32/c9/旧templates/私有slots保留。

9项publisher、3项平台F3诊断、65项协议回归、两仓type/lint/AST与真实UTC解析通过。官方区域核心4h验收约0.84USD，不含其他费用/非硬上限；0.5–1ACU持续活跃的常驻核心估算100–152USD/月，仍应沿用50USD目标做短TTL验收。下一代码优先owned-resource可执行TTL/失败清理，然后逐项新IAM/baseline/读cap/Budget/证书mTLS/DNS，付费Cell最后批准。F3尚未完成，详情在平台 `docs/aws-auto-deployment-fast-track-f3a-readonly-preflight.md`。以下保留历史状态。

## F2g2：平台新协议接线与未安装部署草案完成

2026-10-07（Winnipeg）。平台runner/SDK显式prepared-v2与raw receipt-v2、完整identity/owner、租户database/role动态override、固定baseline pin、request hash/readback隔离已接通，默认legacy协议不变。65项协议/收据测试、129项部署主链、类型/lint/production build通过。平台跨仓脚本实际调用本仓task parser、production invocation、activationFromItem，六操作均通过；只有fixture坐标，无AWS/数据库连接，未重复PG演练。

本仓生产代码及F2g1云端候选源 `19cc3e096df4d37be0a6570ce3116d47c472ace2` 未改变。平台新增只读数据编译器生成TaskDefinition/activation/一个租户代次最小权限草案，无writer/installer，全部readiness和安装授权false。`ecs:DescribeTaskDefinition`不支持资源级权限，需Resource *+region并由admission钉准确ARN；不能用语法合法的image URI/修订ARN冒充真实发布/注册证据。

Source实际只读Inspect仍UPDATE_COMPLETE/Locked/v4，无云写入；未发布新候选、上传私有baseline、注册TaskDefinition、安装IAM/authority、创建ECS/Cell或启动Worker。下一阶段F3集中只读preflight与fresh资源/费用审批；特别核对Aurora实际可用PG版本（session provider当前严格16.14）、原始candidate ZIP/receipt bytes、IAM/boundary和50USD目标。新IAM更新需披露CloudFormation旧managed-policy version清理副作用；新镜像、baseline、activation、付费Cell仍逐项批准。完整记录在平台 `docs/aws-auto-deployment-fast-track-f2g2-prepared-runner.md`。以下保留历史状态。

## F2g1：受审生产admission/CLI root代码与真实PG验证完成，未云启用

2026-10-07 服务端源 `19cc3e096df4d37be0a6570ce3116d47c472ace2` 的 [双镜像候选37702693753](https://github.com/veinyyxy/SpeedFeast_Backend_main/actions/runs/37702693753) 与 [完整CI37702693776](https://github.com/veinyyxy/SpeedFeast_Backend_main/actions/runs/37702693776)实际success。新 `tenant_lifecycle_admission.js` 只读核验固定TaskRole、Fargate metadata/TaskDefinition/registry image、运行窗口、完整平台ownership preimage与ownerDeploymentId，再强一致读取固定authority table的独立runtime descriptor及租户epoch；旧SQL scope hash不冒充平台hash。新 `tenant_lifecycle_admitted_root.js` 校验opaque capability、准确S3 owner/FULL_OBJECT checksum/bytes SHA、进程内baseline compiler品牌，接既有RDS SQL/应用/cleanup；每个SQL query和receipt transport前后重验围栏。

prepared CLI仍以check-bundle为default，选中production mode也不构成批准；需要实际安装的runtime descriptor、当前权威epoch和完整live task proof。共享120s deadline/5s hard-abort，旧inspect/destroy协议保持原限制、不把旧命令自动改成prepared-v2。新镜像声明唯一scratch volume `/tmp/tenant-lifecycle`，admission只接受该匿名临时卷，不接受host/EFS/额外挂载；实际Fargate卷权限与身份仍需未来在线证明。

41项backend相邻测试、6项平台合同测试、两仓typecheck/定向lint、npm生产audit0通过。新root在隔离PG16.14 TLS、非superuser管理账户上实际通过完整SQL/app login/immutable receipt响应丢失恢复/重放不重开/active业务不覆盖/取消与cleanup，临时server已停。AWS admission和S3 transport显式本地替换，compiler复用已真实编译品牌program，不是AWS endpoint/CA/metadata/DynamoDB/S3/ECS证明；私有final receipt `F:/ChatGPT_workshop/techlong-pg16-admitted-root-20261007-f2g2/sessions-receipt.json` SHA `989d41483417eeb5ffafa7324ebe5f5e83b5d31b55bad2dda26c9770e86c198b`。

新app/lifecycle config digest `sha256:75140a5e88550b04f458e2aa2c1b6b7b4326dc1225e11d8491dc2f440ac63206` / `sha256:8cd975a2f73c11e4363ef5fbf298416323f2723a24a68738e72dfdf273342d9e`，Trivy OS HIGH/CRITICAL均0；这两候选未发布，不能把其config当registry digest。日志/REST metadata索引SHA `8da909ad09dba7702772796658924118a5e66d54785e70c8e8dbe2ec28550d24`，未下载原ZIP/receipt。旧已发布镜像保留，Source只读Inspect仍Locked/v4；无AWS/Neon/源PG15/生产baseline写入或权限安装，50USD/月目标不变。

下一小阶段：将平台prepared-v2 command/三个authority参数、receipt v2与SDK request validation接到显式选中的runner，编译但不安装runtime descriptor/新TaskDefinition候选和权限范围；新的image发布、baseline upload/批准、DDB runtime record、IAM和付费Cell各按准确fresh范围确认。当前runtime descriptor新namespace仅为未部署契约；不是schema2 Writer已实现或云已admitted。跨DynamoDB/Postgres/Neon lease不是原子事务，实际concurrency/lease-loss/TTL/cleanup和费用仍待F3，Worker gates不得打开。见 [代码、真实验证与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2g1-admitted-root.md)。以下保留历史状态。

## F2f6：修复镜像已实际发布，独立扫描通过并Locked收尾

2026-10-07 用户确认fresh SHA `15d30e5ec70feb4712c572a404f437405b5d5b9704acd59937423ac4bbd62f80` 后，唯一更新现有两项publisher IAM并完整Grant回读，唯一 [Actions发布37694984927](https://github.com/veinyyxy/SpeedFeast_Backend_main/actions/runs/37694984927) 在publisher main `41b5645dd91c99547dd88d4ac570802c96e4de02` success。准确修复源仍 `40b1ce6e487dc4c1187da3014a89b9379d50d578`，先原始ZIP/checksum/receipt/image load校验再OIDC，没有rebuild/overwrite。两新immutable tag均实际写入，ECR BASIC scan COMPLETE/空severity counts，HIGH/CRITICAL门禁通过；不是普遍无漏洞或ECS ready保证。

app registry manifest digest `sha256:4a92824790cf005c35ab9fd77c4f9756070bf98c74fcd5d16f2dbeae0c80e315`，lifecycle `sha256:a0a0abb59c2acbc370aee39556cae4cf536451387109fe97f9d616817369e858`；独立Source重新Hash每份原始registry manifest、核对各自config digest与受审pin，再独立读扫描通过，未混用digest。发布后Source立即Revoke，22:17:00Z revoke intent、22:17:58Z完整Locked回读；栈UPDATE_COMPLETE/default v4、boundary/唯一inline DenyAll/trust Deny、零attached policy及原两资源，另进程Inspect和完整GetTemplate与原Revoke比较均通过。

旧两个ECR镜像独立读回原digest不变；IAM role/boundary和所有本地/Git策略/模板/执行原文保留。**AWS策略历史版本不是全部保留**：真实列表只有v3/v4，us-east-1 CloudTrail准确记录CloudFormation在本次两更新中分别DeletePolicyVersion v1/v2。不是另发删除role/policy/image资源请求，旧v1/v2云端版本不能恢复同一ID；原策略原文证据已保留。后续审阅必须显式说明CloudFormation的版本清理副作用，不把Retain解释为保留所有IAM历史版本。

私有永久槽位 `F:/ChatGPT_workshop/techlong-reviewed-ecr-republish-15d30e5ec70f`；raw publication receipt SHA `c083333347de746c9b8a66856f944621991ae2b0a4877946214ce3aea019b454`，Locked SHA `ced12daf4562b9688d45809aacd76ab12a85623a3cc2fb8ec523b7664ecd1d2d`，独立verification SHA `fce55ceec12231fd638460f794a550b7cf858b3c69140d266fdc43d2d15717e3`。此SHA/槽位已消费，禁止重放；旧c9fa未执行记录也保留。没有ECS/付费Cell、数据库/Neon/源PG15、baseline/Secret写入或生产Worker/root启用，50USD/月目标保留。下一批仅生产admission/CLI root与准确已发布digest接线，再另审资源/预算和ECS执行；见 [实际发布、版本清理与继续位置](https://github.com/veinyyxy/TechlongSoftware/blob/main/docs/aws-auto-deployment-fast-track-f2f6-ecr-published.md)。以下保留历史状态。

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
