"""Generate a pinned exact-case IANA catalog shared by Python and JavaScript."""

import json
import subprocess
from pathlib import Path
from zoneinfo import available_timezones

import tzdata

root = Path(__file__).resolve().parents[1]
names = sorted(available_timezones())
script = """
let input = '';
for await (const chunk of process.stdin) input += chunk;
const names = JSON.parse(input), zones = [], unsupported = [];
for (const name of names) {
  try { new Intl.DateTimeFormat('en', {timeZone:name}).format(0); zones.push(name); }
  catch { unsupported.push(name); }
}
process.stdout.write(JSON.stringify({zones, unsupported, icuVersion:process.versions.icu}));
"""
process = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(names),
                         capture_output=True, text=True, check=True)
catalog = json.loads(process.stdout)
result = {"version": tzdata.__version__, "icuVersion": catalog["icuVersion"],
          "zones": catalog["zones"], "unsupportedAtBuild": catalog["unsupported"]}
destination = root / "shared/fixtures/time-zones.json"
destination.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(f"Registered {len(result['zones'])} exact-case zones; {len(result['unsupportedAtBuild'])} unsupported by build Intl.")
