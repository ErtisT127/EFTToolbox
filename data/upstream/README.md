# 上游缓存

在仓库根目录运行 `pnpm toolbox data refresh`，下载 PVP 地图依赖并准备本地运行数据。内容包括带中英文翻译的地图、任务、物品和商人数据，地图与楼层规则、静态标记、最新 SVG、原始地图图标，以及战利品、钥匙和手册分类图片。PVE 不在 M2 范围内。

快照地址为 `https://json.tarkov.dev/regular/<name>`；翻译版本在端点名称后加 `_zh` 或 `_en`。`zh/maps` 和 `regular/zh/maps` 会返回 404，`?lang=` 参数也会被忽略，因此只有后缀形式有效。`traders` 会提前下载，因为任务对象只包含商人 ID，任务数据中没有 ID 到名称的映射。

`scripts/config/upstream-sources.json` 固定源仓库版本。实时 API/CDN 快照会在 `versions.json` 中记录 URL、下载时间和 SHA-256；哈希只能标识已下载内容，CDN 不保证历史内容仍可下载。

`scripts/config/upstream-fields.json` 是 `data prepare` 的字段契约，列出各数据面的允许字段。出现未列出的字段，或已有字段消失时，流程会在写入前终止。扩展契约必须经过审查并产生明确差异，不能由 refresh 自动完成。

`source/`、`assets/`、`maps/` 和 `catalog.json` 是生成或下载的缓存目录，已被 Git 忽略。请将 `versions.json`、`validation-report.json`、本文件、准备脚本和源配置纳入版本控制。发布包必须包含生成的运行时缓存以支持离线使用。更新上游时，禁止将 `data/user/` 放入缓存或覆盖其中内容。

刷新成功后，`pnpm toolbox data prepare` 可离线运行。仅使用 SVG 或瓦片的地图会采用对应的上游投影和楼层规则。

`data prepare` 还会逐地图检查读取到的每个上游元素是否已归类为已输出、已跳过、已去重或未分类。统计结果以 `consumed` 写入 `validation-report.json`，数量不足会使该地图失败。失败时保留原有的 `maps/<id>.json`，不写入内容更少的新文件；保留旧数据并返回非零状态，比静默生成不完整产物更安全。

卫星瓦片通过本地后端下载，并按源 URL 的 SHA-256 原子缓存到 `tiles/`；该目录同样被 Git 忽略。`pnpm toolbox data tiles` 会为每个楼层预取最低缩放级别；`pnpm toolbox data tiles --all` 会预取全部级别（约 151,000 个 URL）；添加 `--count` 可只预览数量。已缓存瓦片支持离线使用，未预取的分辨率或区域仍需联网。上游的 404 表示该区域没有瓦片覆盖，会被缓存为透明图片。

瓦片 URL 不含版本信息，重新渲染后可能永久使用缓存中的旧瓦片，发布包也会携带这份旧数据。因此，`tiles/manifest.json` 会记录服务器为每个缓存瓦片返回的校验信息；`pnpm toolbox data tiles --verify` 会向服务器确认是否仍为最新，并修复过期或损坏的文件。只有 `--verify` 会发起这些检查请求；缓存完整时，普通运行只补齐缺口，耗时远低于一秒。当前地图不再引用的瓦片只报告，不删除。

所有下载都经过 `scripts/lib/download.mjs`。该脚本拒绝访问 `raw.githubusercontent.com`、`cdn.jsdelivr.net`、`json.tarkov.dev` 和 `assets.tarkov.dev` 之外的主机，并逐跳跟随重定向，确保每个 URL 在请求前都经过允许列表检查。部分 URL 来自上游数据本身，例如物品的 `baseImageLink` 和地图规则的 `svgPath`；没有这层限制，被篡改的上游数据可能将开发机或 CI 机器指向回环地址或链路本地地址。若合法服务迁移到其他主机，refresh 会明确失败，请将新主机加入该文件中的允许列表。

部分网络无法访问 `raw.githubusercontent.com`，因此 GitHub 请求默认经由 `cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>`。由于固定版本是提交 SHA，jsDelivr 会将其视为不可变版本并提供相同内容，不影响记录的来源；已通过两种方式下载完整图标集并比对哈希确认。设置 `GITHUB_MIRROR=direct` 可绕过镜像，直接访问 GitHub。

下载失败时会使用逐步延长且带抖动的重试间隔（2 秒、5 秒、15 秒），避免立即重试持续撞上同一网络故障。4xx 会被视为 URL 本身的响应，不会重试，429 除外。
