"""Build reproducible staging login and signup Lambda ZIP archives."""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LAMBDA_DIR = ROOT / "lambda"
ZIP_TIMESTAMP = (2020, 1, 1, 0, 0, 0)
PACKAGES = {
    "login": (
        "staging_login.py",
        "staging_auth_common.py",
        "staging_runtime_secret.py",
        "auth_security.py",
        "session_token.py",
    ),
    "signup": (
        "staging_signup.py",
        "staging_auth_common.py",
        "auth_security.py",
    ),
    "membership": (
        "../dist/staging-membership-status/index.mjs",
    ),
}


def build_package(kind: str, output: Path) -> None:
    files = PACKAGES.get(kind)
    if files is None:
        raise ValueError("unsupported staging auth package")
    output = output.resolve()
    if output.exists():
        raise FileExistsError("output already exists")
    sources = tuple((LAMBDA_DIR / name).resolve() for name in files)
    for name, source in zip(files, sources):
        if not source.is_file():
            raise FileNotFoundError(f"required staging auth source is missing: {name}")
    output.parent.mkdir(parents=True, exist_ok=True)
    handler_source = f"staging_{kind}.py"
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, source in zip(files, sources):
            if kind == "membership":
                archive_name = "index.mjs"
            else:
                archive_name = "index.py" if name == handler_source else name
            info = zipfile.ZipInfo(archive_name, ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, source.read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description="build staging auth Lambda ZIP")
    parser.add_argument("--kind", required=True, choices=sorted(PACKAGES))
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    build_package(args.kind, args.output)
    print(f"STAGING_{args.kind.upper()}_LAMBDA_PACKAGE_BUILT")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
