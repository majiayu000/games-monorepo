# 德州扑克 · Nakama / React 示例

这是 Games Monorepo 中仍在开发的德州扑克子项目，使用游戏筹码演示下注与结算。服务端由 Nakama 执行牌局与消息处理，客户端由 React 展示状态。

[仓库快速开始](../../README.md#快速开始) · [狼人杀项目](../werewolf/README.md) · [问题反馈](https://github.com/majiayu000/games-monorepo/issues)

## 本地启动与连接

按根目录快速开始将 `apps/werewolf` 替换为 `apps/poker`，分别构建后端、启动 Docker Compose 和运行客户端。默认前端端口为 `3000`；两款游戏默认使用同一组服务端口，应选择一款运行。

[客户端连接](client/src/hooks/useNakama.ts) 负责认证、Socket 和比赛连接，当前服务地址为 `localhost:7350`、SSL 为 `false`。在另一台设备上直接打开前端时，`localhost` 会指向该设备，需要调整客户端连接设置并提供可达的 Nakama 服务。只有前端页面不足以开展多人牌局。

## 一手牌的阅读顺序

德州扑克每位玩家拿两张底牌，公共牌依次经历翻牌、转牌、河牌；用底牌和公共牌组合最佳五张牌。阅读项目实现时，可从发牌开始追踪每轮下注，再看摊牌和边池结算。

| 想理解的问题 | 源码入口 |
|---|---|
| 一副牌如何构造、洗牌与发牌 | [deck.ts](nakama/src/poker/deck.ts) |
| 七张候选牌怎样评估最佳牌型 | [hand_evaluator.ts](nakama/src/poker/hand_evaluator.ts) |
| 下注、全押和边池如何记录 | [betting.ts](nakama/src/poker/betting.ts) |
| 翻牌前至摊牌的状态如何推进 | [game_state.ts](nakama/src/poker/game_state.ts) |
| 玩家动作怎样通过比赛消息处理 | [match_handler.ts](nakama/src/poker/match_handler.ts) |
| 筹码数据怎样通过 RPC 读写 | [user_chips.ts](nakama/src/rpc/user_chips.ts) |

牌型、牌局、下注和牌组旁边有现有测试文件，可结合例子理解函数的输入与输出。根 README 将本子项目标记为开发中；阅读或修改时请以对应提交的实现为准。当前源码版本见 [提交记录](https://github.com/majiayu000/games-monorepo/commits/main/apps/poker)。
