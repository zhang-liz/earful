# Earful

粘贴一段文字，或者打开任何网页，Earful 就会用自然的声音读给你听。
它会读中文（普通话）和英文，读到哪个词，哪个词就会亮起来。

Earful 在你自己的 Mac 上运行。不用注册，不用联网，你的文字不会发到任何地方。

English: [README.md](README.md)

![Earful 朗读网页](extension/store/screenshots/reading-zh.png)

## 下载

需要 Apple 芯片（M1 或更新）的 Mac，macOS 13 或更新版本。

1. 在[最新版本](https://github.com/zhang-liz/tts/releases/latest)页面下载 `Earful.dmg`。
2. 双击 `Earful.dmg`，把 Earful 拖到“应用程序”文件夹。
3. 第一次打开时，macOS 会说无法验证 Earful。
   这是因为 Earful 没有向苹果付费登记，不是因为它有问题。
   磁盘映像里的 `如何打开 How to open.txt` 一步一步写了怎么打开。

Earful 里面已经有全部声音，不用再下载别的东西，在中国大陆也能用。

## 使用

打开 Earful，浏览器会自动打开朗读页面。

1. 把文字粘贴到框里，多长都可以。
2. 选一个声音。点“试听”可以先听一下。
3. 点“▶ 读给我听”。几秒钟后就开始读。

- 点任何一个词，就从那里开始读。
- 双击文章，可以编辑全文。
- 点“＋ 换一篇”，可以粘贴新的文字。
- 空格键：播放或暂停。← 和 →：上一段、下一段。
- 页面左上方的按钮可以在中文和英文之间切换。

退出 Earful（程序坞里的图标），它就停止工作。

## 朗读网页：浏览器扩展

扩展可以在 Chrome 和 Edge 里朗读任何网页。
在中国大陆打不开 Chrome 应用商店，所以请按下面的步骤自己安装：

1. 先打开一次 Earful 应用。
2. 在[最新版本](https://github.com/zhang-liz/tts/releases/latest)页面下载
   `earful-extension-<版本>.zip`，然后解压。
3. 在浏览器地址栏输入 `chrome://extensions`（Edge 输入 `edge://extensions`）。
4. 打开右上角的“开发者模式”。
5. 点“加载已解压的扩展程序”，选择刚才解压出来的文件夹。

工具栏上会出现一个琥珀色的喇叭图标。如果看不到，点拼图图标，把它固定在工具栏上。

使用方法：

- 在网页上点喇叭图标，或者按 `Alt+R`，就会朗读整个网页。先选中一段文字，就只读那一段。
- 再点一次：暂停或继续。
- 网页底部会出现一个小播放器，可以跳段、调速度。
- 点播放器上的齿轮，可以打开设置：切换中文界面，选择中文和英文的声音。
- 如果 Earful 应用没有打开，播放器会显示“打开 Earful”按钮。点它就行。

## 遇到问题

请在 [Issues](https://github.com/zhang-liz/tts/issues/new/choose) 里告诉我们，用中文写就可以。
安全问题请不要公开发，见 [SECURITY.md](SECURITY.md)。

Mac 应用的日志在 `~/Library/Logs/Earful.log`，报告问题时附上它会很有帮助。

## 许可证

MIT，见 [LICENSE](LICENSE)。Earful 用到的其他项目见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
