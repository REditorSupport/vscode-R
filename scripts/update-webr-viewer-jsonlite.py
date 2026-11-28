"""Regenerate the small offline viewer dependency from vscode-R's pinned webR package."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
from urllib.request import urlopen

root = Path(__file__).resolve().parents[1]
packages = json.loads((root / "src/webr/packages.json").read_text())
package = next(entry for entry in packages if entry["name"] == "jsonlite")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("archive", nargs="?", type=Path, help="use a local copy of the official archive")
args = parser.parse_args()
if args.archive:
    original = args.archive.read_bytes()
else:
    with urlopen(package["url"], timeout=60) as response:
        original = response.read()
if hashlib.sha256(original).hexdigest() != package["sha256"]:
    raise SystemExit("The archive does not match src/webr/packages.json")

# Preserve the namespace, lazy-load databases and compiled Wasm routines.
# Package help, examples and vignettes are available from the full distribution.
metadata = {"jsonlite/DESCRIPTION", "jsonlite/LICENSE", "jsonlite/NAMESPACE"}
directories = ("jsonlite/Meta/", "jsonlite/R/", "jsonlite/libs/")
out = root / "src/webr/resources/viewer-jsonlite.tgz"
with tarfile.open(fileobj=io.BytesIO(original), mode="r:gz") as source, out.open("wb") as stream:
    with gzip.GzipFile(filename="", fileobj=stream, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as target:
            for member in sorted(source.getmembers(), key=lambda entry: entry.name):
                if member.name not in metadata and not member.name.startswith(directories):
                    continue
                if member.isfile():
                    entry = tarfile.TarInfo(member.name)
                    entry.size = member.size
                    target.addfile(entry, source.extractfile(member))
print(out)
