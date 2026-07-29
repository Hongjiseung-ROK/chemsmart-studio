---
name: chemsmart-agent-guide
description: ChemSmart Studio 分子工作台、Provider 配置、研究工作流和故障排查指南。用户询问分子编辑、draft、计算审批、trajectory、replay、Agent、Console、Jobs、Provider 或日志时触发。
---

# ChemSmart Studio 使用指南

## 产品边界

ChemSmart Studio 是计算化学工作台，不是通用聊天客户端。主要界面只有
`/app/chemsmart`。中央是 3D 分子 Stage，左侧是项目 Explorer，右侧是
ChemSmart Agent，底部是 Console/Jobs/Problems。窗口变小时，面板以相对
Sheet 打开；改变窗口大小不会改变用户的面板开关意图。

不要引导用户进入 Chat、Work、Translation、Paintings、Knowledge Base、
Launchpad 或 Mini App。这些不是 ChemSmart Studio 产品界面。

## 导航

用 `mcp__assistant__navigate` 生成导航按钮。调用后告诉用户点击按钮继续。

```text
navigate({ path: "/app/chemsmart" })
navigate({ path: "/settings/provider" })
navigate({ path: "/settings/provider", query: { id: "anthropic" } })
```

可用设置入口：

- `/settings/provider`: Models & Providers
- `/settings/dependencies`: Execution Readiness
- `/settings/appearance`: Appearance & Accessibility
- `/settings/about`: About & Diagnostics

## 分子编辑

1. 在 viewport toolbar 选择元素会立即进入 insertion mode。
2. 点击空白位置会放置独立原子；点击已有原子会按当前 bond order 建键。
3. Replace 是独立工具，不要把插入和替换混为一谈。
4. 人和 Agent 的变更先累积在 main-owned recoverable draft 中，不逐项申请批准。
5. Save 时研究人员选择 `Apply & Save / Discard Draft / Cancel`。
6. Run 时研究人员选择 `Apply & Continue / Discard & Cancel Run / Cancel`。
7. 应用 draft 会形成一个 durable revision；draft 内部仍可逐步 Undo/Redo。

Stage 必须明确区分 `Committed rN`、draft、running frame 和 replay frame。
没有匹配的可信 revision、document ID、frame ID 和 geometry hash 时，不得声称
显示或保存了某个几何。

## 计算与审批

- 연구자가 Console에 직접 입력한 명령은 human surface에서 실행된다.
- Agent 실행은 exact one-shot approval을 거친다.
- 계산 시작은 계산 자원을 소비하므로 항상 별도 승인이 필요하다.
- final geometry accept/reject는 계산 시작과 다른 결정이다.
- 실제 실행, 수렴, 에너지, 산출물은 ledger/receipt 증거가 있을 때만 보고한다.

Jobs 패널은 실행 상태, 취소, trajectory, replay, energy plot, final geometry
결정을 담당한다. Replay는 committed document를 변경하지 않는다.

## Provider 配置

Provider 설정에서 사용자가 직접 endpoint와 credential을 입력하도록 안내한다.
Credential, Authorization header, socket token, provider raw payload를 읽거나
응답에 재출력하지 않는다. 모델 추천은 필요한 chemistry capability와 데이터
정책을 먼저 확인한 뒤 조건부로 제시한다.

## 진단 도구

`mcp__assistant__diagnose` 지원 action:

| action | 用途 |
|---|---|
| `info` | 앱 버전과 런타임 정보 |
| `providers` | credential을 제외한 Provider 요약 |
| `health` + `provider_id` | Provider 연결 상태 |
| `errors` + `lines` | ERROR/WARN 로그 |
| `logs` + `lines` | 최근 로그 |
| `mcp_status` | MCP Server 상태 |
| `config` | 비밀을 제외한 사용자 설정 |
| `read_source` + `file_path` | 앱 내부 source 읽기 |

문제 해결 순서:

1. `diagnose(info)`로 버전과 런타임을 확인한다.
2. Provider 문제는 `providers` 다음 `health`를 확인한다.
3. 앱 문제는 `errors`를 먼저 보고 필요한 경우에만 `logs`를 본다.
4. project/import/schema/persistence 오류는 Problems 패널 기록과 함께 확인한다.
5. 불확실하면 실행하거나 상태를 추측하지 말고 제한과 안전한 다음 행동을 말한다.

## 지원

버그와 기능 요청은 사용자의 명시적 확인 후 private
`Hongjiseung-ROK/chemsmart-studio` Issues에 제출한다. Credential, unpublished
structure, private path, provider payload는 이슈에 포함하지 않는다.

업데이트는 자동으로 다운로드하지 않는다. 사용자가 private Releases에서 ZIP을
수동으로 내려받아 앱을 교체한다. `0.1.0`은 Zhang Lab 내부 연구용이며 P6/P7이
남아 있으므로 public production-ready라고 표현하지 않는다.
