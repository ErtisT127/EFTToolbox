<h1 align="center">EFTToolbox</h1>

<p align="center">English | <a href="README_ZH.md">简体中文</a></p>

<p align="center">
  <b>Maps, prices, and teammates at a glance.</b><br>
  A portable desktop toolkit for Escape from Tarkov, combining an interactive map, live position tracking, image-based price lookup, mobile casting, and multiplayer features so you can spend less time switching out of the game to check maps, prices, or callouts.
</p>

<p align="center">
    <img src="https://img.shields.io/badge/platform-Windows-0078D4?logo=windows" alt="Windows">
    <img src="https://img.shields.io/badge/Go-1.26-00ADD8?logo=go" alt="Go 1.26">
    <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react" alt="React 19">
    <img src="https://img.shields.io/badge/C%23-.NET%2010-512BD4?logo=dotnet" alt="C# and .NET 10">
    <img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="Apache License 2.0">
    <img src="https://img.shields.io/badge/status-In%20Development-orange" alt="In Development">
</p>

<p align="center">
  <img src="docs/efttoolbox-dashboard.jpg" alt="EFTToolbox dashboard" width="100%">
</p>

## 🧰 Features

### 1. Interactive Map

- View floors, loot, quests, extraction points, and custom markers on detailed maps.
- Draw freely, place pins, and add text labels.
- Read game screenshots and logs to detect the current map, floor, and position.
- Use the optional minimap, which can stay over the game screen.

### 2. Image-Based Price Lookup

- Retrieve current item prices online.
- Capture a screenshot with a shortcut, identify the item, and send the price to the overlay.

### 3. Multiplayer and Mobile Casting

- Generate a casting QR code and scan it with a phone to view map information.
- Create or join a room to share positions and markers with teammates and plan routes together.

### 4. Floor Calibration

- Manually calibrate the relationship between elevation and floors so positions better match the game.

## 🚀 Getting Started

1. Download the latest archive from the [Releases page](https://github.com/ErtisT127/EFTToolbox/releases/latest).
2. Extract the archive to any directory.
3. Run `EFTToolbox.exe` from the extracted directory.
4. In `System Settings > System > Game Monitoring`, configure the screenshot and log directories. The screenshot directory is typically `C:\Users\<username>\Documents\Escape from Tarkov\Screenshots`; the log directory is typically `...\Escape from Tarkov\build\Logs`.
5. Set your preferred shortcuts under `System Settings > Hotkeys`.
6. Start using EFTToolbox.

## 🛡️ Security

- EFTToolbox reads game screenshots and logs only.
- It does not inject into the game process, access game memory, or modify game files.

## 🛣️ Roadmap

- [ ] Update floor calibration for Icebreaker.
- [ ] Add abstract maps for Labs, The Maze, and Icebreaker (satellite maps are currently available).
- [ ] Improve floor calibration accuracy on other maps.

## 🙏 Acknowledgements

Thanks to [Tarkov.dev](https://tarkov.dev/) for map assets and data. Third-party dependencies are listed in the `THIRD-PARTY-NOTICES` file included with each release.

## 📜 License

Copyright 2026 ErtisT127

This project is licensed under the [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0). See [LICENSE](LICENSE) for details.
