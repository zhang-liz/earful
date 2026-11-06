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

def check_locales(folder, m):
    """Chrome refuses to load an extension whose word tables do not add up."""
    bad = []
    root = os.path.join(folder, "_locales")
    used = set(re.findall(r"__MSG_(\w+)__", json.dumps(m)))
    default = m.get("default_locale")
    if not os.path.isdir(root):
        if default: bad.append("default_locale is set but there is no _locales folder")
        if used: bad.append("__MSG_ words used but there is no _locales folder")
        return bad
    if not default:
        return bad + ["_locales exists but default_locale is not set"]

    tables = {}
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name, "messages.json")
        if not os.path.isfile(path):
            continue
        try:
            tables[name] = json.load(open(path, encoding="utf-8"))
        except Exception as e:
            bad.append(f"{name}/messages.json will not parse: {e}")
    if default not in tables:
        return bad + [f"default_locale {default!r} has no messages.json"]

    for name, table in tables.items():
        for key, value in table.items():
            if not re.match(r"^[A-Za-z0-9_@]+$", key):
                bad.append(f"{name}: bad message name {key!r}")
            if not isinstance(value, dict) or not isinstance(value.get("message"), str):
                bad.append(f"{name}: {key} has no message")
            elif "$" in value["message"]:
                # Chrome reads $name$ as a placeholder; ours are {name}.
                bad.append(f"{name}: {key} has a $ in it")
        missing = set(tables[default]) - set(table)
        extra = set(table) - set(tables[default])
        if missing: bad.append(f"{name} is missing {sorted(missing)}")
        if extra: bad.append(f"{name} has words {default} lacks: {sorted(extra)}")
    for key in sorted(used - set(tables[default])):
        bad.append(f"manifest uses __MSG_{key}__ but {default} has no {key}")
    described = re.fullmatch(r"__MSG_(\w+)__", m.get("description", ""))
    for name, table in tables.items():
        if described and len(table.get(described.group(1), {}).get("message", "")) > 132:
            bad.append(f"{name}: description over 132 characters")
    return bad

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

    bad += check_locales(folder, m)

    files = []
    if m.get("background",{}).get("service_worker"): files.append(m["background"]["service_worker"])
    if m.get("action",{}).get("default_popup"): files.append(m["action"]["default_popup"])
    if m.get("options_ui",{}).get("page"): files.append(m["options_ui"]["page"])
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
