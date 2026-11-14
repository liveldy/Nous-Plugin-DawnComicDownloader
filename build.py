#!/usr/bin/env python3
"""Build script for the DawnComicDownloader native runtime modules.

Usage:
    python build.py windows

Produces ``dist/DawnComicDownloader-windows-x64.module.zip`` containing ``app/plugin.jar`` and a
jlink-produced ``runtime/`` (with ``runtime/bin/java.exe``), which is the layout the Nous
host expects for a ``runtime.windows-x64`` module of ``type: 'jvm'``.

Everything is compiled against Java release 17 so the jar also loads on hosts that pin
an older JDK than the one used for jlink.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent
ENGINE_JAVA = PLUGIN_ROOT / "engine" / "java"
WORK_ROOT = PLUGIN_ROOT / "build"
DIST_ROOT = PLUGIN_ROOT / "dist"

JAVA_RELEASE = "17"
ENTRY_CLASS = "app.dawncomic.PluginMain"
MODULES = ["java.base", "java.logging", "java.net.http", "jdk.crypto.ec", "jdk.zipfs"]

# Reproducible packaging: every archive entry gets a fixed timestamp so the manifest's
# pinned sha256 survives a rebuild on the same JDK. Bump these only on purpose.
JAR_DATE = "2020-01-01T00:00:00Z"
ZIP_DATE = (1980, 1, 1, 0, 0, 0)

TARGETS = {
    "windows": {
        "work": "windows-x64",
        "zip": "DawnComicDownloader-windows-x64.module.zip",
        "label": "windows-x64",
    },
}


def find_jdk() -> Path:
    """Locate the JDK: ``JAVA_HOME`` first, then ``D:\\JDK26`` and PATH."""
    candidates = []
    env_home = os.environ.get("JAVA_HOME")
    if env_home:
        candidates.append(Path(env_home))
    candidates.append(Path(r"D:\JDK26"))
    for base in candidates:
        if (base / "bin" / "javac.exe").is_file() and (base / "bin" / "jlink.exe").is_file():
            return base
    for name in ("javac.exe", "javac"):
        found = shutil.which(name)
        if found:
            return Path(found).resolve().parent.parent
    raise SystemExit("JDK not found: set JAVA_HOME or install a JDK 17+ under D:\\JDK26")


def run(cmd: list[str], what: str) -> str:
    """Run a build step, echoing the command and failing loudly on a non-zero exit."""
    print(f"[build] {what}: {' '.join(cmd)}")
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.stdout.strip():
        print(proc.stdout.rstrip())
    if proc.stderr.strip():
        print(proc.stderr.rstrip(), file=sys.stderr)
    if proc.returncode != 0:
        raise SystemExit(f"[build] FAILED ({what}) exit={proc.returncode}")
    return proc.stdout


def java_sources() -> list[Path]:
    """Collect every ``.java`` file under ``engine/java`` (shared + per-platform trees)."""
    files = sorted(p for p in ENGINE_JAVA.rglob("*.java") if p.is_file())
    if not files:
        raise SystemExit(f"[build] no Java sources under {ENGINE_JAVA}")
    return files


def build(target: str) -> Path:
    """Compile, link a runtime, and package the module ZIP for ``target``."""
    spec = TARGETS[target]
    jdk = find_jdk()
    work = WORK_ROOT / spec["work"]
    classes = work / "classes"
    app_dir = work / "app"
    runtime = work / "runtime"
    jar_path = app_dir / "plugin.jar"

    print(f"[build] jdk={jdk} target={target} work={work}")

    if classes.exists():
        shutil.rmtree(classes)
    classes.mkdir(parents=True, exist_ok=True)
    if app_dir.exists():
        shutil.rmtree(app_dir)
    app_dir.mkdir(parents=True, exist_ok=True)
    DIST_ROOT.mkdir(parents=True, exist_ok=True)

    sources = java_sources()
    print(f"[build] sources ({len(sources)}):")
    for src in sources:
        print(f"         {src.relative_to(PLUGIN_ROOT)}")

    compile_cmd = [
        str(jdk / "bin" / "javac.exe"),
        "--release",
        JAVA_RELEASE,
        "-encoding",
        "UTF-8",
        "-Xlint:all",
        "-d",
        str(classes),
    ] + [str(p) for p in sources]
    run(compile_cmd, "javac")

    # ``--date`` normalises entry timestamps so rebuilds produce identical bytes. The JDK 26
    # jar tool only resolves ``-C <dir> .`` correctly on Windows (explicit entry names are
    # looked up against the CWD and fail), so the tree is walked from the directory instead;
    # javac writes classes in the order of the sorted source list, which keeps that walk stable.
    run(
        [str(jdk / "bin" / "jar.exe"), "--create", "--file", str(jar_path),
         f"--date={JAR_DATE}", "-C", str(classes), "."],
        "jar",
    )

    java_exe = runtime / "bin" / "java.exe"
    if java_exe.is_file():
        print(f"[build] jlink: reusing existing runtime at {runtime}")
    else:
        run(
            [
                str(jdk / "bin" / "jlink.exe"),
                "--add-modules",
                ",".join(MODULES),
                "--strip-debug",
                "--no-header-files",
                "--no-man-pages",
                "--output",
                str(runtime),
            ],
            "jlink",
        )

    module_list = run([str(java_exe), "--list-modules"], "runtime modules")

    zip_path = DIST_ROOT / spec["zip"]
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for base, prefix in ((app_dir, "app"), (runtime, "runtime")):
            for path in sorted(base.rglob("*")):
                if not path.is_file():
                    continue
                arcname = f"{prefix}/{path.relative_to(base).as_posix()}"
                info = zipfile.ZipInfo(arcname, date_time=ZIP_DATE)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 0
                info.external_attr = 0o644 << 16
                with open(path, "rb") as src, zf.open(info, "w") as dst:
                    shutil.copyfileobj(src, dst, 1 << 20)
        names = set(zf.namelist())
    required = {"app/plugin.jar", "runtime/bin/java.exe"}
    missing = required - names
    if missing:
        raise SystemExit(f"[build] FAILED: zip is missing {sorted(missing)}")
    if "app/plugin.jar" in names and any(n.startswith("app/classes/") for n in names):
        raise SystemExit("[build] FAILED: classes directory leaked into the jar path layout")

    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    size = zip_path.stat().st_size
    with zipfile.ZipFile(zip_path) as zf:
        entries = len(zf.namelist())

    print()
    print(f"module : {spec['label']} ({target})")
    print(f"entry  : {ENTRY_CLASS}")
    print(f"zip    : {zip_path}")
    print(f"size   : {size} bytes ({size / 1024 / 1024:.2f} MiB)")
    print(f"entries: {entries}")
    print(f"sha256 : {digest}")
    print("modules:")
    for line in module_list.splitlines():
        line = line.strip()
        if line:
            print(f"         {line}")
    return zip_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the DawnComicDownloader native module ZIPs.")
    parser.add_argument("platform", choices=sorted(TARGETS) + ["android"], nargs="?", default="windows",
                        help="target platform (only windows is implemented)")
    args = parser.parse_args()
    if args.platform == "android":
        raise SystemExit("[build] android is not part of this module; only 'windows' is supported")
    build(args.platform)


if __name__ == "__main__":
    main()
