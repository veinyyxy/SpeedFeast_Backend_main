"""Extract exactly the four checked files into a fresh, job-owned directory."""
import os
from pathlib import Path
import shutil
import sys
import zipfile


def extract(archive, output):
    expected = {"image.tar.gz", "candidate-receipt.json", "self-check.json", "SHA256SUMS"}
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if len(entries) != 4 or {x.filename for x in entries} != expected:
            raise ValueError("Unexpected artifact inventory")
        for entry in entries:
            limit = 471859200 if entry.filename == "image.tar.gz" else 65536
            if entry.is_dir() or entry.file_size > limit or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("Unsafe or oversized artifact entry")
        Path(output).mkdir()  # Never overwrite or reset an occupied directory.
        for entry in entries:
            with source.open(entry) as src, open(Path(output) / entry.filename, "xb") as dst:
                shutil.copyfileobj(src, dst, length=1024 * 1024)
            os.chmod(Path(output) / entry.filename, 0o600)


if __name__ == "__main__":
    extract(sys.argv[1], sys.argv[2])
