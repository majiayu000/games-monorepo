# Games Monorepo

基于 Nakama 游戏服务器的多人在线游戏集合。

## 游戏列表

| 游戏 | 描述 | 状态 |
|------|------|------|
| [狼人杀](./apps/werewolf) | 6-18人实时对战，10种角色 | ✅ 完成 |
| [扑克](./apps/poker) | 多人在线扑克游戏 | 🚧 开发中 |

## 技术栈

- **后端**: Nakama (TypeScript) + CockroachDB
- **前端**: React 18 + Vite + Tailwind CSS
- **实时通信**: WebSocket (nakama-js)
- **状态管理**: Zustand
- **动画**: Framer Motion

## 快速开始

```bash
# 安装依赖
bun install

# 启动 Docker (Nakama + CockroachDB)
docker-compose up -d

# 启动狼人杀前端
bun run dev:werewolf

# 启动扑克前端
bun run dev:poker
```

## 项目结构

```
games-monorepo/
├── apps/
│   ├── werewolf/          # 狼人杀游戏
│   │   ├── client/        # React 前端
│   │   ├── nakama/        # Nakama 后端
│   │   └── docker-compose.yml
│   └── poker/             # 扑克游戏
│       ├── client/
│       ├── nakama/
│       └── docker-compose.yml
├── packages/
│   └── shared/            # 共享代码 (TODO)
├── package.json
└── README.md
```

## 端口

| 服务 | 端口 |
|------|------|
| Nakama API | 7350 |
| Nakama Console | 7351 |
| 狼人杀前端 | 3000 |
| 扑克前端 | 3001 |

---

🤖 Generated with Claude Code
