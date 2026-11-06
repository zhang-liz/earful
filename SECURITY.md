# Security

## Report a problem

Please do not open a public issue for a security problem.

Report it privately: open
https://github.com/zhang-liz/earful/security/advisories/new and fill in the form.
We reply within 7 days.

## What Earful does with your data

- Earful reads text on your own computer. It does not send your text to
  any other service.
- By default the server listens only on `127.0.0.1`, so only your own
  computer can reach it.
- When you share it on your network (`./run.sh --lan`), set `TTS_PASSWORD`.
  Then every request needs the password.

## Supported versions

Only the latest release gets security fixes.
