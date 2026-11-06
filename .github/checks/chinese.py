"""Read Chinese through the real server and the real model.

The unit tests fake the voice. This checks the parts they cannot: the Chinese
model loads, every part gets sound, and the words come back timed in order.
Run against a server on 127.0.0.1:8888.
"""

import json
import sys
import time
import urllib.request

SERVER = "http://127.0.0.1:8888"
TEXT = (
    "苹果公司发布了新款 iPhone，搭载最新的 AI 芯片，价格从5999元起。\n\n"
    + "今天上午，北京市政府召开新闻发布会，介绍了今年城市绿化工作的最新进展。" * 8
)


def call(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(SERVER + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=600) as response:  # noqa: S310 - local server
        return json.loads(response.read())


job = call("/speak", {"text": TEXT})
deadline = time.time() + 600
while (progress := call(f"/progress-once/{job['id']}"))["state"] == "running":
    if time.time() > deadline:
        sys.exit("Chinese reading did not finish")
    time.sleep(1)
if progress["state"] != "ready":
    sys.exit(f"Chinese reading failed: {progress['error']}")

for part in range(progress["total"]):
    words = call(f"/words/{job['id']}/{part}")["words"]
    starts = [w["s"] for w in words]
    if not words or starts != sorted(starts):
        sys.exit(f"part {part}: words missing or out of order")
    print(f"part {part}: {len(words)} words, last ends at {words[-1]['e']}s")
first = [w["t"] for w in call(f"/words/{job['id']}/0")["words"]]
if "iPhone" not in first:
    sys.exit(f"English inside Chinese was dropped: {first}")
# 8 sentences of 36 characters at about 4 per second: well over 50 s of sound.
if progress["seconds"] < 50:
    sys.exit(f"only {progress['seconds']} s of sound: some text was not read")
print(f"OK: {progress['seconds']} s of Chinese")
