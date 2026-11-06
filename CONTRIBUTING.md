# Contributing to Earful

Thank you for helping. Bug reports, fixes and translations are all welcome.

## Report a bug

Open an issue with the "Bug report" form. Say what you did, what you expected,
and what happened. You can write in English or Chinese.

Found a security problem? Do not open a public issue. See `SECURITY.md`.

## Set up

You need a Mac or Linux computer, [uv](https://docs.astral.sh/uv/) and Node.js 22.

```bash
git clone https://github.com/zhang-liz/tts.git
cd tts
./run.sh                 # starts Earful at http://127.0.0.1:8888
```

## Run the checks

Run these before you open a pull request. CI runs the same ones.

```bash
uv sync && npm ci --prefix app
uv run pytest                                     # server
npm test --prefix app                             # web page
npm test --prefix extension                       # Chrome extension
python3 extension/check-manifest.py extension     # extension manifest
uvx ruff check app tests                          # Python lint
app/node_modules/.bin/eslint -c app/eslint.config.mjs \
  app/index.html app/continue.html extension/*.js editor-extension/src
```

The VS Code extension tests (`npm test --prefix editor-extension`) need the
server running on port 8888 first.

## Pull requests

- One topic per pull request. Small is better.
- Add or change a test for each fix.
- Every word a person sees comes from a strings file. Add each new word to
  both languages:
  - web page: `app/strings/en.json` and `app/strings/zh.json`
  - Chrome extension: `extension/_locales/en/messages.json` and
    `extension/_locales/zh_CN/messages.json`
- Write in plain words: short sentences, one idea in each.

## License

By sending a pull request, you agree that your work is under the MIT license
of this project.
