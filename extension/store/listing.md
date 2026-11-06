# Store listing: Chrome Web Store and Edge Add-ons

Copy each field into the store's form. The store shows the Chinese text to
readers whose browser is in Chinese (add `zh_CN` as a second language), and
the English text to everyone else. The extension's name and short
description come from `_locales` already.

## Category

Accessibility (Edge: Accessibility).

## Detailed description — English

Earful reads web pages aloud in a natural voice, and lights up each word as
it is spoken.

- Click the Earful icon, or press Alt+R, to read the page. Select text first
  to read only that.
- Click any sentence to read from there. Change the speed with − and +.
- Reads English and Mandarin Chinese, and English words inside Chinese.
- Shows its buttons and settings in English or Chinese. One click switches.

Earful needs the free Earful app on your Mac. The app makes the voice on
your own computer: your text is never sent to the internet, and there is no
account and no fee.

## 详细说明 — 中文

Earful 用自然的声音朗读网页，读到哪个词，哪个词就会亮起来。

- 点击 Earful 图标，或按 Alt+R，就开始朗读整个页面。先选中文字，就只读选中的部分。
- 点击页面上任意一句，就从那里开始读。用 − 和 + 调整语速。
- 能读中文（普通话）和英文，中文里夹着的英文单词也能读对。
- 按钮和设置可以显示中文或英文，一键切换。

Earful 需要配合你 Mac 上免费的 Earful 应用使用。声音在你自己的电脑上生成：
你的文字不会发到网上，不用注册，也不收费。

## Single purpose

Reads the current web page, or the selected text, aloud with a voice made by
the Earful app on the user's own computer.

## Why each permission is needed

- **contextMenus**: the right-click items "Read this aloud" and "Read the
  whole page".
- **storage**: the user's settings: voices, speed, language, the app's
  address.
- **activeTab** and **scripting**: to read the text of the tab the user asks
  to read, in a tab opened before the extension was installed.
- **offscreen**: to play the sound. Many pages do not let their own audio
  load from the user's computer.
- **Host permission for 127.0.0.1 and localhost**: to reach the Earful app
  on the user's own computer, which makes the voice.
- **Content script on all pages**: so the reader can start on any page with
  one click or Alt+R, and so the spoken word can be lit in the page.
- **Optional host permission for http://\*/\***: asked only if the user
  points the extension at the Earful app on another of their own computers.

## Data use (the store's privacy form)

- Collects no personal data. Sends nothing to the developer or anyone else.
- The text being read goes only to the Earful app at the address in the
  settings, by default this same computer (127.0.0.1).
- Privacy policy: the text in `privacy.md`, published at a public address.
