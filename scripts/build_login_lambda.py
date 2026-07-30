"""Build a reproducible local ZIP for the existing login Lambda.

The allow-list is intentionally explicit so the shared session-token helper
cannot be omitted by an ad-hoc glob or broad repository archive.
"""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LAMBDA_DIR = ROOT / "lambda"
PACKAGE_FILES = ("login.py", "auth_security.py", "session_token.py")
ZIP_TIMESTAMP = (2020, 1, 1, 0, 0, 0)


def build_package(output: Path) -> None:
    output = output.resolve()
    if output.exists():
        raise FileExistsError("output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in PACKAGE_FILES:
            source = LAMBDA_DIR / name
            if not source.is_file():
                raise FileNotFoundError(f"required login Lambda source is missing: {name}")
            info = zipfile.ZipInfo(name, ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, source.read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description="build the local login Lambda ZIP")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    build_package(args.output)
    print("LOGIN_LAMBDA_PACKAGE_BUILT")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
