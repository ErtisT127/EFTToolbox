# 命令

所有命令均在仓库根目录执行。

## Toolbox

入口：`pnpm toolbox <command>`

### 数据

```bash
pnpm toolbox data refresh             # 下载并准备全部数据
pnpm toolbox data sources             # 下载上游数据快照
pnpm toolbox data icons               # 下载地图图标
pnpm toolbox data svgs                # 下载地图 SVG
pnpm toolbox data items [mode]        # 拉取物品图片和目录
pnpm toolbox data fonts               # 生成字体和 emoji
pnpm toolbox data fonts --check       # 检查字体产物
pnpm toolbox data prepare             # 生成运行时数据
pnpm toolbox data tiles               # 预取最低缩放级别瓦片
pnpm toolbox data tiles --all         # 预取全部缩放级别瓦片
pnpm toolbox data tiles --all --count # 统计瓦片数量，不下载
TILE_CONCURRENCY=16 pnpm toolbox data tiles --all # 设置瓦片并发数
```

### 打包

```bash
pnpm toolbox package          # 构建便携包，HEAD 必须位于 vMAJOR.MINOR.PATCH Tag
pnpm toolbox package --lite   # 减少瓦片资源
pnpm toolbox package --fast   # 构建不携带 data 的快速包
pnpm toolbox package --debug  # Debug 构建：无 Tag 时使用 0.0.0-dev
```

### 检查与清理

```bash
pnpm toolbox lint                    # 运行代码检查
pnpm toolbox clean                   # 清理构建产物
pnpm toolbox cache check dashboard   # 检查构建缓存
pnpm toolbox cache save dashboard    # 保存构建缓存
```

`cache` 的目标也可以是 `backend`。

## 开发服务

```bash
bash scripts/platform/dev.sh                                  # Bash
bash scripts/platform/dev.sh 47832                            # 指定端口
bash scripts/platform/dev.sh 47831 --rebuild                  # 强制重新构建
powershell -ExecutionPolicy Bypass -File scripts/platform/dev.ps1 # PowerShell
```

默认端口：`47831`。

## 根目录任务

```bash
pnpm test:maps          # 运行地图逻辑测试
pnpm contracts          # 生成 contracts
pnpm contracts:check    # 检查 contracts
pnpm defaults           # 生成默认值代码
pnpm defaults:check     # 检查默认值代码
pnpm third-party        # 生成致谢列表
pnpm third-party:check  # 检查致谢列表
pnpm i18n:check         # 检查 i18n 键
pnpm build              # 构建 contracts、默认值和 Dashboard
pnpm format             # 格式化代码
pnpm changelog          # 生成 CHANGELOG
```

`contracts`、`defaults`、`third-party` 会写入生成文件；对应的 `:check` 命令只检查。
