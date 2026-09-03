"""Check a Chrome extension manifest the way Chrome does at load time."""
import json, os, re, sys

# Permissions Chrome actually accepts in Manifest V3. Anything else is
# rejected with "Permission 'x' is unknown", which stops the whole load.
VALID = {
 "activeTab","alarms","audio","background","bookmarks","browsingData",
 "certificateProvider","clipboardRead","clipboardWrite","contentSettings",
 "contextMenus","cookies","debugger","declarativeContent",
 "declarativeNetRequest","declarativeNetRequestFeedback",
 "declarativeNetRequestWithHostAccess","desktopCapture","documentScan",
 "downloads","downloads.open","downloads.ui","enterprise.deviceAttributes",
 "enterprise.hardwarePlatform","enterprise.networkingAttributes",
 "enterprise.platformKeys","favicon","fileBrowserHandler","fileSystemProvider",
 "fontSettings","gcm","geolocation","history","identity","identity.email",
 "idle","loginState","management","nativeMessaging","notifications",
 "offscreen","pageCapture","platformKeys","power","printerProvider",
 "printing","printingMetrics","privacy","processes","proxy","readingList",
 "runtime","scripting","search","sessions","sidePanel","storage",
 "system.cpu","system.display","system.memory","system.storage","tabCapture",
 "tabGroups","tabs","topSites","tts","ttsEngine","unlimitedStorage",
 "userScripts","vpnProvider","wallpaper","webAuthenticationProxy",
 "webNavigation","webRequest","webRequestBlocking",
}

def bad_host(p):
    m = re.match(r"^(\*|https?|file|ftp)://([^/]*)(/.*)$", p)
    if not m: return True
    host = m.group(2)
    if host in ("*", ""): return False
    if host.startswith("*."): host = host[2:]
    return "*" in host

def check(folder):
    path = os.path.join(folder, "manifest.json")
    try:
        m = json.load(open(path))
    except Exception as e:
        return [f"manifest.json will not parse: {e}"]

    bad = []
    if m.get("manifest_version") != 3: bad.append("manifest_version must be 3")
    if not re.match(r"^\d+(\.\d+){0,3}$", m.get("version","")): bad.append("bad version")
    if len(m.get("description","")) > 132: bad.append("description over 132 characters")

    for p in m.get("permissions", []):
        if p not in VALID: bad.append(f"Permission '{p}' is unknown")
    for p in m.get("optional_permissions", []):
        if p not in VALID: bad.append(f"Optional permission '{p}' is unknown")

    for key in ("host_permissions","optional_host_permissions"):
        for p in m.get(key, []):
            if bad_host(p): bad.append(f"invalid pattern in {key}: {p}")
    for cs in m.get("content_scripts", []):
        for p in cs.get("matches", []):
            if p != "<all_urls>" and bad_host(p):
                bad.append(f"invalid content script match: {p}")

    files = []
    if m.get("background",{}).get("service_worker"): files.append(m["background"]["service_worker"])
    if m.get("action",{}).get("default_popup"): files.append(m["action"]["default_popup"])
    for cs in m.get("content_scripts", []): files += cs.get("js",[]) + cs.get("css",[])
    files += list(m.get("icons",{}).values())
    files += list(m.get("action",{}).get("default_icon",{}).values())
    for f in files:
        if not os.path.exists(os.path.join(folder, f)): bad.append(f"missing file: {f}")
    return bad

if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else "."
    problems = check(folder)
    for p in problems: print("  -", p)
    print("FAIL" if problems else "OK: Chrome will load this.")
    sys.exit(1 if problems else 0)
