# Third-party notices

Earful's own code is under the MIT license (see `LICENSE`). Earful uses the
work of other projects. Their licenses are listed here.

The Mac app (`Earful.dmg`) carries a copy of each of these projects inside
`Earful.app/Contents/Resources`. The license text of each Python package is in
its `*.dist-info` folder under `py/lib/python3.*/site-packages`.

## GPL-3.0 parts in the Mac app

These two parts are under the GNU General Public License, version 3 or later.
The full text is in `licenses/GPL-3.0.txt`. You can get their source code here:

| Part | Version | Source |
|---|---|---|
| eSpeak NG (`libespeak-ng` and `espeak-ng-data`, shipped in `espeakng-loader`) | 1.52.0 | https://github.com/espeak-ng/espeak-ng/tree/1.52.0 |
| phonemizer-fork | 3.3.2 | https://pypi.org/project/phonemizer-fork/3.3.2/#files |

The Earful code that uses them is public at https://github.com/zhang-liz/tts.
If a link above stops working, open an issue there and we will send you the
source.

## Voices and models

| Part | License | Source |
|---|---|---|
| Kokoro-82M (English voices) | Apache-2.0 | https://huggingface.co/hexgrad/Kokoro-82M |
| Kokoro-82M-v1.1-zh (Chinese voices) | Apache-2.0 | https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh |
| spaCy `en_core_web_sm` | MIT | https://github.com/explosion/spacy-models |

## Main libraries

| Part | License |
|---|---|
| Python (python-build-standalone) | PSF-2.0 |
| kokoro, misaki | Apache-2.0 |
| PyTorch | BSD-3-Clause and others |
| transformers, huggingface-hub, tokenizers, safetensors | Apache-2.0 |
| spaCy, thinc and other Explosion libraries | MIT |
| jieba, pypinyin, cn2an | MIT |
| num2words | LGPL-2.1 |
| FastAPI, pydantic | MIT |
| uvicorn, starlette | BSD-3-Clause |
| numpy, soundfile | BSD |
| certifi, tqdm | MPL-2.0 (tqdm also MIT) |

To list every package and its license in a clone:

```bash
uv export --frozen --no-dev --no-hashes --no-emit-project
```
