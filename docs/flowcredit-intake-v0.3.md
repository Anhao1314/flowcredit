# FlowCredit Product v0.3.1 Assessment Intake

产品版本：`flowcredit.intake/v0.3.1`  
风险规则：`flowcredit.risk_result/v0.2.1`

v0.3.1 是采集、确认和会话产品层，不是新的评分模型。TAI、CCI、EQS、Veto、等级和决策政策继续完全由 v0.2.1 确定性规则计算。

相较 v0.3，本版本统一浏览器与服务端校验，保形处理数组和结构化证据，限定 27–31 天主评分窗口，并把确定性计算与 DeepSeek 可用性解耦。空白或不完整草稿会明确显示 `LIMITED`，非法草稿显示 `NOT READY`，完整且合法时才显示 `READY`。

## 用户路径

```text
Describe or import → Review extracted data → Resolve missing items
→ Confirm → Deterministic assessment → AI explanation → Report
```

Workspace 只突出 `Start a new assessment`。预置案例位于 `Try an example`，自定义任务支持自然语言、JSON 和手动表单三种入口。高级 Token 分类、历史序列、交叉核验和证据元数据默认折叠。

## 输入边界

- Token 单位为百万，金额为 USD，比率为 0–100 百分数。
- 主字段覆盖范围、Token 活动、GPU 与商业数据、回款与客户结构、至少六期历史和证据元数据。
- JSON 文件只在浏览器解析，上限 64 KB；自然语言上限 10,000 字符。
- 缺失维度允许继续评估，但相关 TAI/CCI 保持 null，决策不得伪装为完整结果。
- 客户端提交的评分、Peer、权重、Normalized Token、TAI、CCI、PD、等级、额度和批准结论均被忽略。
- 自定义输入始终强制 `assessmentMode=real`，服务端选择注册的 normalization 和 peer profile。

## API

- `GET /fc/ai/v0.3/config`
- `GET /fc/ai/v0.3/schema`
- `POST /fc/ai/v0.3/extract`
- `POST /fc/ai/v0.3/assess`
- `POST /fc/ai/v0.3/ask`

`extract` 需要 `draftId`、`text` 和 `modelConsent=true`。`assess` 接受白名单化 draft，默认不调用模型。`ask` 必须同时提供当前自定义 `sessionId`、问题和模型授权。

## 隐私与会话

- 草稿、结果和 sessionId 位于当前标签页 `sessionStorage`，最多 5 项，关闭标签后清除。
- 原始 JSON 文件不上传；自然语言提取完成后删除原始文本。
- 没有授权时，真实经营数据不得发送给 DeepSeek。
- 授权复核只发送白名单结构化字段、确定性结果或 F1–F12 事实。
- 日志仅保存哈希、耗时、Token 用量、状态和错误类别。
- GitHub Pages 不能运行 Node Agent，因此只提供草稿准备和模拟案例；完整自定义评估仅监听本机 `127.0.0.1:8787`。

本产品用于保守型风险初筛，不是法定审计、授信决定或金融建议。
