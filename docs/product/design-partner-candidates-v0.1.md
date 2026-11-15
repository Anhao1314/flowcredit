# Design Partner 候选调研 v0.1 — AI Compute Risk Monitor

**状态：** 桌面调研（Desk Research），**未验证痛点与付费意愿**。
**日期：** 2026-11-16
**目标：** 为 PRD 的 ICP（HK/SG GPU 云 / AI 推理服务商）找出可公开触达的真实候选，用于第一轮 Design Partner 接触。
**方法：** 公开网页检索 + 官网核对（Brave/官网/新闻稿），不做任何未经同意的联系；所有结论附公开链接。

> 重要边界：以下只能证明"公司存在、业务匹配、公开信息可查"，**不能**证明他们缺这套产品。
> 真正的验证只能来自一次对话（见第 5 节问题清单）。

---

## 1. 筛选标准

| 标准 | 为什么 |
| --- | --- |
| 卖 GPU 算力 / 推理 API 给多个 B2B 客户 | 才有"客户经营与回款风险"这个问题 |
| 自有 billing + GPU 遥测 + 合同/回款数据 | 我们的 intake 字段（Token/GPU/收入/回款）能对上 |
| 有账期/授信/后付费 | 否则没有应收账款风险可管 |
| HK/SG 可触达（或有 APAC 实体） | 时区、合同、数据授权可操作 |
| 规模 20–500 个 B2B 客户 | 太小没预算，太大（hyperscaler）采购周期过长 |

## 2. 候选总表

| 候选 | 地点 | 业务 | 匹配度 | 触达 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **Aethir** | 总部新加坡（Built In Singapore 标注 HQ Singapore；官网未写） | 分布式 GPU 云（Aethir Earth 裸金属 GPU / Atmosphere 云游戏） | A- | 官网 Access Compute / Partner 表单 | Web3 模式，可能用 compute credits 结算；数据部分在链上 |
| **SMC / Firmus** | 新加坡实体 `Firmus Metal International Pte. Ltd.` | 液冷 GPU 云（H100/H200/L40S，SG + India，99.5% SLA） | A | 官网 Enquire Now | 中等规模、企业+创业公司客户；有 billing console（console.smc.co） |
| **Singtel RE:AI** | 新加坡（Singtel AI Infrastructure Pte. Ltd., UEN 202414710C） | GPUaaS + MaaS + **Token-as-a-Service（按 Token 计费）** | A（但采购慢） | 企业销售 | 数据最匹配（TaaS 天然有 Token 账单）；但 Telco 采购/合规周期长，适合作为第二家或战略合作 |
| **Novita AI** | HQ 未在官网标注（LinkedIn/Crunchbase 指向新加坡，**待核实**） | 推理 API（200+ 模型，按 Token 计费）+ GPU Cloud + Agent Sandbox | A- | sales 会议链接 / support@novita.ai / gpu@novita.ai | 客户含 Hugging Face、OpenRouter 等；按 Token 计费 → 对账需求强 |
| **OneAsia（oneas1a）** | 香港（+852 电话，DC 含 HK/SH/广州/泰国/韩国/日本） | 数据中心 + GPUaaS（OAsis 超算，按分钟计费，A/H/GB 系列） | A- | info@oneas1a.com / 表单 / WhatsApp | HK 本地交付强；更偏 colo+云，客户以企业为主 |
| **UCloud Global** | 新加坡/香港区域（中国 UCloud 海外品牌） | AI 云 + GPU 服务器 + 统一 AI API，28 regions/36 AZ，宣称 6 万企业用户 | B+ | overseasbusiness@ucloud.cn | 区域覆盖好、客户多；中资背景，采购与数据合规需确认 |
| **GMI Cloud** | 台湾/美国（官网未写 HQ；案例含台湾公共部门） | GPU 云 + **Serverless 推理** + Agent runtime | B+ | Contact Sales / Console | 推理按需计费，APAC 覆盖但非 SG/HK 本地 |
| **OgCloud** | 香港（IaaS 含 HK 机房） | GPU 云（4090 等）+ 云服务器 | B | sales@ogcloud.net | 规模较小，信息不完整（价格/规格缺失） |
| **Spheron** | 全球 marketplace（发布 APAC 清单的媒体） | 聚合多家 GPU 供应商的 marketplace | C（渠道） | 官网表单 | 不是终端 ICP，但可作为渠道/合作方 |
| **SCX.ai / Sharon AI** | 澳大利亚 | GPU 云/neocloud | C（区域外） | 官网 | APAC 但非 HK/SG |
| **Sakura Internet** | 日本 | GPU 云 | C（区域外） | 官网 | 日本市场，暂不优先 |

**排除：** AWS / GCP / Azure / Oracle / 阿里云 / 腾讯云 / 华为云（采购周期与自研信用体系不匹配）；Equinix / STT / Digital Edge 等 colo（不持有客户用量数据）；Lambda / RunPod / CoreWeave / Crusoe / Nebius（无 SG/HK 区域，沟通成本高）。

## 3. 优先接触顺序（建议）

### 第一优先：SMC / Firmus（新加坡）

- **为什么先找它：** 新加坡实体、自有 H100 集群、客户是创业公司与企业、有公开 SLA 与 billing console——"客户用量 vs 回款"的问题天然存在；规模适中，决策链比 Singtel 短。
- **公开证据：** <https://smc.co/>（H100/H200/L40S、SG+India、99.5% SLA、"Singapore's most energy-efficient GPU cloud"）。
- **接触：** 官网 `Enquire Now`；首封邮件找 **CFO / Head of Finance / Revenue Operations**，不要找销售。
- **开场角度：** "你们的客户按 GPU 小时/预留集群付费，是否存在大客户用量上涨但回款变慢的情况？我们在做一个把用量、账单、回款对齐的证据化风险复核工具，想找 1 家设计伙伴用真实数据跑 3 个月。"

### 第二优先：Aethir（新加坡）

- **为什么：** 分布式 GPU 云，客户与 GPU 供应商都可能存在结算/信用风险；有企业客户与 compute credit 体系。
- **风险：** Web3 结算与链上数据可能让"经营数据"不完整；需要确认是否有法币 billing 与应收账款。
- **接触：** 官网 Partner / Access Compute 表单；首封邮件问"企业客户的账期与信用政策由谁负责"。

### 第三优先：OneAsia（香港）

- **为什么：** 香港本地 DC + GPUaaS，按分钟计费，企业客户多；HK 市场比 SG 更容易面对面。
- **风险：** 更偏 colo/托管，客户数可能没有 SaaS 型推理平台多；需要确认是否有后付费/账期。
- **接触：** info@oneas1a.com / 表单（注明 "GPUaaS 客户信用与回款风险"）。

### 观察名单

- **Novita AI**：产品最匹配（Token 计费 + GPU 云），但 HQ 与数据合规需核实；如果确认新加坡实体，可升到第一优先。
- **Singtel RE:AI**：数据最匹配（TaaS 按 Token 计费），但 Telco 采购慢；适合作为第二阶段的战略/渠道合作，而不是第一个设计伙伴。
- **UCloud Global**：区域与客户规模合适，但中资背景的数据跨境与采购流程需先确认。

## 4. 桌面尽调清单（接触前 30 分钟）

对每个候选做以下检查，任一红灯就降级：

- [ ] 官网是否有明确的 **billing / pricing / 后付费/账期** 说明（没有账期 = 没有应收账款风险）
- [ ] 是否公开列出 **企业客户案例**（说明有 B2B 合同，而非只有开发者自助）
- [ ] 招聘页是否有 **Credit / Collections / Revenue Operations / FP&A** 岗位（有 = 他们在意回款）
- [ ] 公司注册处可查实体（新加坡 ACRA / 香港公司注册处），确认法律实体与注册地址
- [ ] 是否已经使用 ERP/信用保险/催收系统（避免"我们已经有解决方案"）
- [ ] 数据合规：是否有公开的 DPA/隐私政策；客户数据是否允许第三方处理

## 5. 第一次对话的资格问题（不要推销）

1. 你们现在有多少个 B2B 客户是**后付费/账期**结算？平均账期多久？
2. 客户用量（GPU 小时/Token）与账单、回款目前怎么对账？谁做？多久一次？
3. 最近 12 个月有没有出现"用量涨、收入没涨、回款变慢"的客户？怎么发现的？
4. 如果有一个系统能每天自动对账并给出"证据可追溯的风险变化"，你会让谁用？预算归谁？
5. 你愿意用脱敏的 6 个月数据做一次设计伙伴试点吗？需要什么审批？

> 如果 3/4/5 都答不上来或没有预算归属，这家不是 Design Partner，只是"感兴趣的人"。

## 6. 首封邮件模板（短、具体、不群发）

> 主题：关于 GPU 客户用量与回款对账的一个设计伙伴邀请
>
> 你好，[Name]，
>
> 我在做一个面向 GPU 云/推理服务商的风险复核工具：把客户的 Token/GPU 用量、账单、收入和回款对齐，输出每个结论都能追溯到原始记录的风险报告，并由独立复核人签署。
>
> 我们不卖"信用评分"，也不做自动授信——只解决一个问题：**当一个大客户的用量在涨、回款在变慢时，能不能提前、有证据地发现。**
>
> 想找 1 家设计伙伴，用 6 个月脱敏数据跑 3 次月度复核，不收取费用；产出归你们，我们只保留匿名化的方法验证。
>
> 如果这件事在你们那里由 CFO/财务运营负责，方便帮我转给对应的人，或者 15 分钟聊一下你们的对账流程吗？
>
> [Name] · FlowCredit · [链接]

## 7. 诚实结论

- 这 6 家都**符合 ICP 的公开特征**，但没有一家被验证有痛点或预算。
- 最可能先回应的不是最大的公司，而是 **SMC/Firmus 或 OneAsia** 这类"中等规模、有企业客户、有账期"的厂商。
- 如果 10 封定向邮件后没有任何一家愿意做数据试点，说明问题可能不在产品，而在**这个人群当前没有把"客户信用风险"当作优先事项**——那时应该换 ICP（例如先服务 AI 企业的 CFO，而不是 GPU 云厂商），而不是继续加功能。
