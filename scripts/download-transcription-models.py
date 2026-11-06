#!/usr/bin/env python3
"""Install the administrator-configured models, verifying SHA-256 before replacement."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tempfile
import urllib.request


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    models = json.loads(args.config.read_text())["models"]
    args.directory.mkdir(parents=True, exist_ok=True)
    for model in models:
        name = Path(model["path"]).name
        expected = model["sha256"]
        if not re.fullmatch(r"[a-zA-Z0-9_.-]+\.bin", name) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise ValueError("Invalid model filename or checksum")
        if not model["url"].startswith("https://"):
            raise ValueError("Model downloads must use HTTPS")
        destination = args.directory / name
        if destination.is_file() and digest(destination) == expected:
            print(f"Verified {name}")
            continue
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=args.directory, delete=False) as output:
                temporary = Path(output.name)
                with urllib.request.urlopen(model["url"], timeout=60) as response:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
            if digest(temporary) != expected:
                raise ValueError(f"Checksum mismatch: {name}")
            temporary.chmod(0o644)
            temporary.replace(destination)
            print(f"Installed {name}")
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
