# Hpoi 手办维基 情报 Telegram Channel

[Telegram Channel](https://t.me/hpoi_info)

## 部署

1. 克隆仓库到本地；
2. 更新 `src/config.ts`（参考 `src/config.sample.ts`）；
3. 安装依赖 `npm install`；
4. 构建源代码: `npm run build`；
5. 创建 `/etc/systemd/system/hpoi-info.service`：

```
[Unit]
Description=Hpoi 手办维基 - 情报
After=network.target

[Service]
WorkingDirectory=<REPLACE IT WITH YOUR CLONE PATH>
Environment=NODE_ENV=production
User=<REPLACE IT WITH YOUR USER NAME>
Type=oneshot
ExecStart=/usr/bin/npm start

[Install]
WantedBy=multi-user.target
```

6. 创建 `/etc/systemd/system/hpoi-info.timer`：

```
[Unit]
Description=Hpoi 手办维基 - 情报

[Timer]
OnCalendar=*:0/10:00
Persistent=true

[Install]
WantedBy=timers.target
```

7. 激活并立即启动 timer：`systemctl enable --now hpoi-info.timer`

