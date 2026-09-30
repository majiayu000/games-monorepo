# Games Monorepo

基于 Nakama 游戏服务器与 React 的多人在线游戏集合，包含狼人杀和德州扑克。

[快速开始](#快速开始) · [狼人杀说明](apps/werewolf/README.md) · [狼人杀部署文档](apps/werewolf/DEPLOY.md)

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

需要 Node.js 18+、npm 和 Docker Compose。在仓库根目录选择一款游戏启动；两套后端使用相同宿主机端口，请勿同时启动。

以狼人杀为例：

```bash
# 安装并构建选定游戏的后端
cd apps/werewolf/nakama
npm install
npm run build

# 在游戏目录启动 Nakama + CockroachDB
cd ..
docker compose up -d

# 安装并启动前端
cd client
npm install
npm run dev
```

打开 <http://localhost:3000/>。另开终端操作时，请从仓库根目录进入对应目录。

启动扑克时，在以上命令中将 `apps/werewolf` 替换为 `apps/poker`；扑克前端配置的默认端口也是 `3000`。

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
| 扑克前端 | 3000（单独运行） |

---

🤖 Generated with Claude Code
