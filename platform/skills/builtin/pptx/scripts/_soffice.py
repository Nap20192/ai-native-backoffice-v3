"""Run LibreOffice headless for the document skills. Not a CLI.

OpenMA port, new file. The same copy lives in the pptx and xlsx skills,
because each skill is mounted on its own. It finds LibreOffice under either
command name, gives every run its own temporary profile so parallel runs do
not lock each other out, stops a run that hangs, and names the environment
image that has LibreOffice when it is missing.
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import tempfile
from pathlib import Path

OFFICE_IMAGE = "Рабочее место с LibreOffice"

MISSING_GUIDANCE = (
    f"LibreOffice (soffice) is not in this sandbox. It ships in the "
    f"environment image \"{OFFICE_IMAGE}\": ask the user to pick that image "
    f"on the environment card and start a new session. Do not install "
    f"LibreOffice with apt-get, it is too large for a session sandbox."
)


class OfficeError(RuntimeError):
    """LibreOffice failed or ran past its timeout."""


def find_soffice() -> str | None:
    """Path of the LibreOffice binary, like `command -v soffice || command -v libreoffice`."""
    return shutil.which("soffice") or shutil.which("libreoffice")


def convert(soffice: str, src: str | os.PathLike, outdir: str | os.PathLike,
            target: str, timeout: int, extra: list[str] | None = None,
            env: dict[str, str] | None = None) -> Path:
    """Convert ``src`` into ``outdir`` as ``target`` (pdf, xlsx:...) and
    return the produced file. Raises OfficeError on failure or timeout."""
    src = Path(src)
    with tempfile.TemporaryDirectory(prefix="oma-lo-profile-") as profile:
        cmd = [soffice, f"-env:UserInstallation={Path(profile).as_uri()}",
               "--headless", "--norestore", *(extra or []),
               "--convert-to", target, "--outdir", str(outdir), str(src)]
        # On Debian soffice is a launcher that starts soffice.bin as its
        # child. A timeout stops the whole process group, else a hung
        # soffice.bin would outlive the run and hold the VM memory.
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True,
                                encoding="utf-8", errors="replace", env=env,
                                start_new_session=True)
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.communicate()
            raise OfficeError(
                f"LibreOffice timed out after {timeout} s converting "
                f"{src.name}; try again or pass a larger --timeout") from None
    ext = target.split(":", 1)[0]
    produced = Path(outdir) / f"{src.stem}.{ext}"
    if proc.returncode != 0 or not produced.exists():
        detail = (stderr or stdout).strip()[-500:]
        raise OfficeError(f"LibreOffice could not convert {src.name} to {ext} "
                          f"(exit {proc.returncode}): {detail}")
    return produced
